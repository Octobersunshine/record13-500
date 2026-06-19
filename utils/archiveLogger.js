const fs = require('fs');
const path = require('path');
const CONFIG = require('../config');

function ensureLogDirectory() {
  if (!fs.existsSync(CONFIG.logging.logDir)) {
    fs.mkdirSync(CONFIG.logging.logDir, { recursive: true });
  }
}

function getLogFilePath() {
  return path.join(CONFIG.logging.logDir, CONFIG.logging.archiveLogFile);
}

function rotateLogFileIfNeeded(logPath) {
  try {
    if (fs.existsSync(logPath)) {
      const stats = fs.statSync(logPath);
      if (stats.size >= CONFIG.logging.maxLogFileSize) {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(
          CONFIG.logging.logDir,
          `slow-queries-archive-${timestamp}.log`
        );
        fs.renameSync(logPath, backupPath);
        console.log(`[Log Rotation] Archived to: ${backupPath}`);
      }
    }
  } catch (err) {
    console.error('[Log Rotation Error]', err.message);
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
  const logPath = getLogFilePath();
  rotateLogFileIfNeeded(logPath);

  try {
    fs.appendFileSync(logPath, logEntry, { flag: 'a', encoding: 'utf8' });
    return true;
  } catch (err) {
    console.error('[Write Log Error]', err.message);
    return false;
  }
}

function readSlowQueries(limit = 100) {
  const logPath = getLogFilePath();

  if (!fs.existsSync(logPath)) {
    return [];
  }

  const content = fs.readFileSync(logPath, 'utf8');
  const lines = content.trim().split('\n').filter(Boolean);

  return lines
    .slice(-limit)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return { raw: line };
      }
    })
    .reverse();
}

module.exports = {
  ensureLogDirectory,
  formatLogEntry,
  writeToArchiveLog,
  readSlowQueries
};
