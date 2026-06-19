const fs = require('fs');
const path = require('path');
const CONFIG = require('../config');

const LOG_FILE_REGEX = /^slow-queries-archive-(\d{4}-\d{2}-\d{2})-(\d+)\.log$/;
const LEGACY_LOG_FILE = 'slow-queries-archive.log';

function ensureLogDirectory() {
  if (!fs.existsSync(CONFIG.logging.logDir)) {
    fs.mkdirSync(CONFIG.logging.logDir, { recursive: true });
  }
}

function formatDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getAllLogFiles() {
  ensureLogDirectory();
  const files = fs.readdirSync(CONFIG.logging.logDir);
  
  const logFiles = [];
  
  for (const file of files) {
    const match = file.match(LOG_FILE_REGEX);
    if (match) {
      const filePath = path.join(CONFIG.logging.logDir, file);
      const stats = fs.statSync(filePath);
      logFiles.push({
        filename: file,
        path: filePath,
        date: match[1],
        sequence: parseInt(match[2]),
        size: stats.size,
        mtime: stats.mtime
      });
    }
  }
  
  logFiles.sort((a, b) => {
    if (a.date !== b.date) return b.date.localeCompare(a.date);
    return b.sequence - a.sequence;
  });
  
  return logFiles;
}

function getCurrentLogFilePath(targetDate = formatDate()) {
  const allFiles = getAllLogFiles();
  const todayFiles = allFiles.filter(f => f.date === targetDate);
  
  let nextSequence = 1;
  let currentFile = null;
  
  if (todayFiles.length > 0) {
    todayFiles.sort((a, b) => b.sequence - a.sequence);
    const latestFile = todayFiles[0];
    
    if (latestFile.size < CONFIG.logging.maxLogFileSize) {
      currentFile = latestFile.path;
    } else {
      nextSequence = latestFile.sequence + 1;
    }
  }
  
  if (!currentFile) {
    if (nextSequence > CONFIG.logging.rotation.maxFilesPerDay) {
      throw new Error(`Maximum files per day (${CONFIG.logging.rotation.maxFilesPerDay}) reached`);
    }
    currentFile = path.join(
      CONFIG.logging.logDir,
      `slow-queries-archive-${targetDate}-${String(nextSequence).padStart(3, '0')}.log`
    );
  }
  
  return currentFile;
}

function migrateLegacyLogIfExists() {
  const legacyPath = path.join(CONFIG.logging.logDir, LEGACY_LOG_FILE);
  
  if (fs.existsSync(legacyPath)) {
    const stats = fs.statSync(legacyPath);
    if (stats.size > 0) {
      const legacyDate = formatDate(new Date(stats.mtime));
      const targetPath = path.join(
        CONFIG.logging.logDir,
        `slow-queries-archive-${legacyDate}-000.log`
      );
      
      let finalPath = targetPath;
      let counter = 1;
      while (fs.existsSync(finalPath)) {
        finalPath = path.join(
          CONFIG.logging.logDir,
          `slow-queries-archive-${legacyDate}-${String(counter).padStart(3, '0')}.log`
        );
        counter++;
      }
      
      try {
        fs.renameSync(legacyPath, finalPath);
        console.log(`[Log Migration] Legacy log migrated to: ${path.basename(finalPath)}`);
      } catch (err) {
        console.error('[Log Migration Error]', err.message);
      }
    } else {
      try {
        fs.unlinkSync(legacyPath);
      } catch (err) {
        // ignore
      }
    }
  }
}

function formatLogEntry(entry, threshold) {
  const timestamp = new Date().toISOString();
  const logData = {
    timestamp,
    sql: entry.sql,
    executionTime: entry.executionTime,
    threshold,
    database: entry.database || 'unknown',
    application: entry.application || 'unknown',
    traceId: entry.traceId || null,
    parameters: entry.parameters || null,
    userId: entry.userId || null,
    clientIp: entry.clientIp || null
  };
  return JSON.stringify(logData) + '\n';
}

function writeToArchiveLog(logEntry) {
  ensureLogDirectory();
  migrateLegacyLogIfExists();
  
  const today = formatDate();
  const logPath = getCurrentLogFilePath(today);
  
  try {
    fs.appendFileSync(logPath, logEntry, { flag: 'a', encoding: 'utf8' });
    return true;
  } catch (err) {
    console.error('[Write Log Error]', err.message);
    return false;
  }
}

function readLogFile(filePath, limit, currentCount) {
  if (currentCount >= limit) return [];
  
  const remaining = limit - currentCount;
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);
  
  const start = Math.max(0, lines.length - remaining);
  const selectedLines = lines.slice(start);
  
  return selectedLines
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    })
    .reverse();
}

function readSlowQueries(limit = 100, dateFrom = null, dateTo = null) {
  const allFiles = getAllLogFiles();
  
  let filteredFiles = allFiles;
  
  if (dateFrom || dateTo) {
    filteredFiles = allFiles.filter(f => {
      if (dateFrom && f.date < dateFrom) return false;
      if (dateTo && f.date > dateTo) return false;
      return true;
    });
  }
  
  const results = [];
  let count = 0;
  
  for (const file of filteredFiles) {
    if (count >= limit) break;
    
    try {
      const entries = readLogFile(file.path, limit, count);
      results.push(...entries);
      count += entries.length;
    } catch (err) {
      console.error(`[Read Log Error] ${file.filename}:`, err.message);
    }
  }
  
  return results;
}

function getLogFileList() {
  const allFiles = getAllLogFiles();
  return allFiles.map(f => ({
    filename: f.filename,
    date: f.date,
    sequence: f.sequence,
    size: f.size,
    sizeFormatted: formatFileSize(f.size),
    mtime: f.mtime.toISOString()
  }));
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function cleanupOldLogs(retentionDays = CONFIG.logging.rotation.retentionDays) {
  if (!CONFIG.logging.rotation.autoCleanup) {
    return { deleted: 0, freedSpace: 0, skipped: 'Auto cleanup disabled' };
  }
  
  const allFiles = getAllLogFiles();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);
  const cutoffDateStr = formatDate(cutoffDate);
  
  const deleted = [];
  let freedSpace = 0;
  
  for (const file of allFiles) {
    if (file.date < cutoffDateStr) {
      try {
        const stats = fs.statSync(file.path);
        fs.unlinkSync(file.path);
        deleted.push(file.filename);
        freedSpace += stats.size;
        console.log(`[Log Cleanup] Deleted: ${file.filename}`);
      } catch (err) {
        console.error(`[Log Cleanup Error] ${file.filename}:`, err.message);
      }
    }
  }
  
  return {
    deleted: deleted.length,
    deletedFiles: deleted,
    freedSpace,
    freedSpaceFormatted: formatFileSize(freedSpace),
    retentionDays,
    cutoffDate: cutoffDateStr
  };
}

function getLogStats() {
  const allFiles = getAllLogFiles();
  const totalSize = allFiles.reduce((sum, f) => sum + f.size, 0);
  
  const dateGroups = {};
  for (const file of allFiles) {
    if (!dateGroups[file.date]) {
      dateGroups[file.date] = { count: 0, size: 0 };
    }
    dateGroups[file.date].count++;
    dateGroups[file.date].size += file.size;
  }
  
  return {
    totalFiles: allFiles.length,
    totalSize,
    totalSizeFormatted: formatFileSize(totalSize),
    dateRange: allFiles.length > 0 ? {
      from: allFiles[allFiles.length - 1].date,
      to: allFiles[0].date
    } : null,
    byDate: dateGroups,
    retentionDays: CONFIG.logging.rotation.retentionDays,
    maxFileSize: CONFIG.logging.maxLogFileSize,
    maxFileSizeFormatted: formatFileSize(CONFIG.logging.maxLogFileSize)
  };
}

function deleteLogFile(filename) {
  const filePath = path.join(CONFIG.logging.logDir, filename);
  
  if (!LOG_FILE_REGEX.test(filename)) {
    throw new Error('Invalid log filename');
  }
  
  if (!fs.existsSync(filePath)) {
    throw new Error('Log file not found');
  }
  
  const stats = fs.statSync(filePath);
  fs.unlinkSync(filePath);
  
  return {
    deleted: filename,
    size: stats.size,
    sizeFormatted: formatFileSize(stats.size)
  };
}

function extractTableNames(sql) {
  if (!sql || typeof sql !== 'string') {
    return ['unknown'];
  }

  const tables = new Set();
  const sqlLower = sql.toLowerCase();
  const cleanSql = sql.replace(/\s+/g, ' ').trim();

  const selectMatch = cleanSql.match(/FROM\s+([\w\s,.`"\[\]]+?)(?:\s+WHERE|\s+GROUP|\s+ORDER|\s+HAVING|\s+LIMIT|\s+JOIN|\s+INNER|\s+LEFT|\s+RIGHT|\s+CROSS|\s+UNION|\s*$)/i);
  if (selectMatch) {
    const fromClause = selectMatch[1];
    parseTableList(fromClause).forEach(t => tables.add(t));
  }

  const joinPattern = /\s+(?:INNER\s+|LEFT\s+|RIGHT\s+|FULL\s+|CROSS\s+)?JOIN\s+([\w`"\[\].]+)\s+/gi;
  let joinMatch;
  while ((joinMatch = joinPattern.exec(cleanSql)) !== null) {
    const table = cleanTableName(joinMatch[1]);
    if (table) tables.add(table);
  }

  const insertMatch = cleanSql.match(/INSERT\s+INTO\s+([\w`"\[\].]+)/i);
  if (insertMatch) {
    const table = cleanTableName(insertMatch[1]);
    if (table) tables.add(table);
  }

  const updateMatch = cleanSql.match(/UPDATE\s+([\w`"\[\].]+)\s+SET/i);
  if (updateMatch) {
    const table = cleanTableName(updateMatch[1]);
    if (table) tables.add(table);
  }

  const deleteMatch = cleanSql.match(/DELETE\s+FROM\s+([\w`"\[\].]+)/i);
  if (deleteMatch) {
    const table = cleanTableName(deleteMatch[1]);
    if (table) tables.add(table);
  }

  if (tables.size === 0) {
    return ['unknown'];
  }

  return Array.from(tables).filter(t => t && t.length > 0);
}

function parseTableList(fromClause) {
  const tables = [];
  const parts = fromClause.split(',');
  
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    
    const tableMatch = trimmed.match(/^([\w`"\[\].]+)/);
    if (tableMatch) {
      const table = cleanTableName(tableMatch[1]);
      if (table) tables.push(table);
    }
  }
  
  return tables;
}

function cleanTableName(tableName) {
  if (!tableName) return null;
  
  let cleaned = tableName.trim();
  cleaned = cleaned.replace(/[`"\[\]]/g, '');
  
  if (cleaned.includes('.')) {
    const parts = cleaned.split('.');
    cleaned = parts[parts.length - 1];
  }
  
  return cleaned.toLowerCase();
}

function getSlowQueryStats(dateFrom = null, dateTo = null) {
  const allFiles = getAllLogFiles();
  
  let filteredFiles = allFiles;
  if (dateFrom || dateTo) {
    filteredFiles = allFiles.filter(f => {
      if (dateFrom && f.date < dateFrom) return false;
      if (dateTo && f.date > dateTo) return false;
      return true;
    });
  }

  const tableStats = {};
  let totalQueries = 0;
  let totalExecutionTime = 0;

  for (const file of filteredFiles) {
    try {
      const content = fs.readFileSync(file.path, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const tables = extractTableNames(entry.sql);
          
          for (const table of tables) {
            if (!tableStats[table]) {
              tableStats[table] = {
                tableName: table,
                count: 0,
                totalExecutionTime: 0,
                avgExecutionTime: 0,
                maxExecutionTime: 0,
                minExecutionTime: Infinity
              };
            }
            
            tableStats[table].count++;
            tableStats[table].totalExecutionTime += entry.executionTime;
            tableStats[table].maxExecutionTime = Math.max(
              tableStats[table].maxExecutionTime,
              entry.executionTime
            );
            tableStats[table].minExecutionTime = Math.min(
              tableStats[table].minExecutionTime,
              entry.executionTime
            );
          }
          
          totalQueries++;
          totalExecutionTime += entry.executionTime;
        } catch {
          continue;
        }
      }
    } catch (err) {
      console.error(`[Read Log Error] ${file.filename}:`, err.message);
    }
  }

  const result = Object.values(tableStats).map(stat => ({
    ...stat,
    avgExecutionTime: stat.count > 0 ? Math.round(stat.totalExecutionTime / stat.count) : 0,
    minExecutionTime: stat.minExecutionTime === Infinity ? 0 : stat.minExecutionTime,
    percentage: totalQueries > 0 ? ((stat.count / totalQueries) * 100).toFixed(2) : 0
  }));

  result.sort((a, b) => b.count - a.count);

  return {
    totalQueries,
    totalExecutionTime,
    avgExecutionTime: totalQueries > 0 ? Math.round(totalExecutionTime / totalQueries) : 0,
    uniqueTables: result.length,
    byTable: result,
    dateRange: filteredFiles.length > 0 ? {
      from: filteredFiles[filteredFiles.length - 1].date,
      to: filteredFiles[0].date
    } : null
  };
}

function getTopSlowQueries(limit = 10, dateFrom = null, dateTo = null) {
  const allFiles = getAllLogFiles();
  
  let filteredFiles = allFiles;
  if (dateFrom || dateTo) {
    filteredFiles = allFiles.filter(f => {
      if (dateFrom && f.date < dateFrom) return false;
      if (dateTo && f.date > dateTo) return false;
      return true;
    });
  }

  const queries = [];

  for (const file of filteredFiles) {
    try {
      const content = fs.readFileSync(file.path, 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          queries.push(entry);
        } catch {
          continue;
        }
      }
    } catch (err) {
      console.error(`[Read Log Error] ${file.filename}:`, err.message);
    }
  }

  queries.sort((a, b) => b.executionTime - a.executionTime);

  return {
    total: queries.length,
    limit,
    data: queries.slice(0, limit)
  };
}

migrateLegacyLogIfExists();

module.exports = {
  ensureLogDirectory,
  formatLogEntry,
  writeToArchiveLog,
  readSlowQueries,
  getLogFileList,
  cleanupOldLogs,
  getLogStats,
  deleteLogFile,
  getAllLogFiles,
  formatDate,
  extractTableNames,
  getSlowQueryStats,
  getTopSlowQueries
};
