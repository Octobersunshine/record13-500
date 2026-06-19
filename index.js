const express = require('express');
const CONFIG = require('./config');
const {
  ensureLogDirectory,
  formatLogEntry,
  writeToArchiveLog,
  readSlowQueries,
  getLogFileList,
  getLogStats,
  cleanupOldLogs,
  deleteLogFile,
  getSlowQueryStats,
  getTopSlowQueries,
  extractTableNames
} = require('./utils/archiveLogger');

const app = express();
const PORT = CONFIG.server.port;

let slowQueryThreshold = CONFIG.slowQuery.threshold;
let cleanupTimer = null;

app.use(express.json({ limit: '10mb' }));

app.post('/api/sql/monitor', (req, res) => {
  const { sql, executionTime, database, application, traceId, parameters, userId, clientIp } = req.body;

  if (!sql || typeof executionTime !== 'number') {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields: sql (string) and executionTime (number)'
    });
  }

  const isSlowQuery = executionTime >= slowQueryThreshold;

  if (isSlowQuery) {
    const logEntry = formatLogEntry(
      { sql, executionTime, database, application, traceId, parameters, userId, clientIp },
      slowQueryThreshold
    );
    const written = writeToArchiveLog(logEntry);

    if (!written) {
      return res.status(500).json({
        success: false,
        error: 'Failed to write slow query to archive log'
      });
    }
  }

  res.json({
    success: true,
    data: {
      isSlowQuery,
      executionTime,
      threshold: slowQueryThreshold,
      archived: isSlowQuery
    }
  });
});

app.post('/api/sql/batch-monitor', (req, res) => {
  const queries = req.body.queries;

  if (!Array.isArray(queries)) {
    return res.status(400).json({
      success: false,
      error: 'Request must contain a "queries" array'
    });
  }

  const results = [];
  let archivedCount = 0;
  let errorCount = 0;

  for (const query of queries) {
    const { sql, executionTime, database, application, traceId, parameters, userId, clientIp } = query;

    if (!sql || typeof executionTime !== 'number') {
      errorCount++;
      results.push({
        success: false,
        error: 'Missing required fields',
        sql: sql || 'unknown'
      });
      continue;
    }

    const isSlowQuery = executionTime >= slowQueryThreshold;
    let archived = false;

    if (isSlowQuery) {
      const logEntry = formatLogEntry(
        { sql, executionTime, database, application, traceId, parameters, userId, clientIp },
        slowQueryThreshold
      );
      archived = writeToArchiveLog(logEntry);
      if (archived) archivedCount++;
    }

    results.push({
      success: true,
      isSlowQuery,
      executionTime,
      threshold: slowQueryThreshold,
      archived
    });
  }

  res.json({
    success: true,
    data: {
      total: queries.length,
      archived: archivedCount,
      errors: errorCount,
      results
    }
  });
});

app.get('/api/sql/slow-queries', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const dateFrom = req.query.dateFrom || null;
  const dateTo = req.query.dateTo || null;

  try {
    const parsedLogs = readSlowQueries(limit, dateFrom, dateTo);
    res.json({
      success: true,
      data: parsedLogs,
      meta: {
        limit,
        dateFrom,
        dateTo,
        count: parsedLogs.length
      }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.get('/api/logs/files', (req, res) => {
  try {
    const files = getLogFileList();
    res.json({
      success: true,
      data: {
        files,
        total: files.length
      }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.get('/api/logs/stats', (req, res) => {
  try {
    const stats = getLogStats();
    res.json({
      success: true,
      data: stats
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.delete('/api/logs/:filename', (req, res) => {
  const { filename } = req.params;

  try {
    const result = deleteLogFile(filename);
    res.json({
      success: true,
      data: result
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

app.post('/api/logs/cleanup', (req, res) => {
  const retentionDays = req.body.retentionDays !== undefined ? parseInt(req.body.retentionDays) : undefined;

  try {
    const result = cleanupOldLogs(retentionDays);
    res.json({
      success: true,
      data: result
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.get('/api/stats/by-table', (req, res) => {
  const dateFrom = req.query.dateFrom || null;
  const dateTo = req.query.dateTo || null;

  try {
    const stats = getSlowQueryStats(dateFrom, dateTo);
    res.json({
      success: true,
      data: stats
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.get('/api/stats/top-slow', (req, res) => {
  const limit = parseInt(req.query.limit) || 10;
  const dateFrom = req.query.dateFrom || null;
  const dateTo = req.query.dateTo || null;

  try {
    const result = getTopSlowQueries(limit, dateFrom, dateTo);
    res.json({
      success: true,
      data: result
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.post('/api/utils/extract-tables', (req, res) => {
  const { sql } = req.body;

  if (!sql) {
    return res.status(400).json({
      success: false,
      error: 'Missing required field: sql'
    });
  }

  try {
    const tables = extractTableNames(sql);
    res.json({
      success: true,
      data: {
        sql,
        tables
      }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    data: {
      slowQueryThreshold,
      logDir: CONFIG.logging.logDir,
      archiveLogFile: CONFIG.logging.archiveLogFile,
      maxLogFileSize: CONFIG.logging.maxLogFileSize,
      maxLogFileSizeFormatted: formatBytes(CONFIG.logging.maxLogFileSize),
      rotation: CONFIG.logging.rotation
    }
  });
});

app.put('/api/config/threshold', (req, res) => {
  const { threshold } = req.body;

  if (typeof threshold !== 'number' || threshold <= 0) {
    return res.status(400).json({
      success: false,
      error: 'Threshold must be a positive number (milliseconds)'
    });
  }

  slowQueryThreshold = threshold;

  res.json({
    success: true,
    data: {
      slowQueryThreshold
    }
  });
});

app.put('/api/config/retention', (req, res) => {
  const { retentionDays } = req.body;

  if (typeof retentionDays !== 'number' || retentionDays <= 0) {
    return res.status(400).json({
      success: false,
      error: 'Retention days must be a positive number'
    });
  }

  CONFIG.logging.rotation.retentionDays = retentionDays;

  res.json({
    success: true,
    data: {
      retentionDays: CONFIG.logging.rotation.retentionDays
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'running',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      autoCleanup: CONFIG.logging.rotation.autoCleanup,
      retentionDays: CONFIG.logging.rotation.retentionDays
    }
  });
});

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function startAutoCleanup() {
  if (CONFIG.logging.rotation.autoCleanup && !cleanupTimer) {
    const cleanupInterval = 24 * 60 * 60 * 1000;
    
    setTimeout(() => {
      const result = cleanupOldLogs();
      if (result.deleted > 0) {
        console.log(`[Auto Cleanup] Deleted ${result.deleted} files, freed ${result.freedSpaceFormatted}`);
      }
    }, 5 * 60 * 1000);
    
    cleanupTimer = setInterval(() => {
      const result = cleanupOldLogs();
      if (result.deleted > 0) {
        console.log(`[Auto Cleanup] Deleted ${result.deleted} files, freed ${result.freedSpaceFormatted}`);
      }
    }, cleanupInterval);
    
    console.log(`[Auto Cleanup] Started, interval: 24h, retention: ${CONFIG.logging.rotation.retentionDays} days`);
  }
}

function stopAutoCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    console.log('[Auto Cleanup] Stopped');
  }
}

function gracefulShutdown(signal) {
  console.log(`\n[${signal}] Received shutdown signal...`);
  stopAutoCleanup();
  console.log('Cleanup complete, shutting down.');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

ensureLogDirectory();
startAutoCleanup();

app.listen(PORT, () => {
  const stats = getLogStats();
  console.log(`\n========================================`);
  console.log(`  SQL Monitor Service`);
  console.log(`========================================`);
  console.log(`  Server running on port ${PORT}`);
  console.log(`  Slow query threshold: ${slowQueryThreshold}ms`);
  console.log(`  Log directory: ${CONFIG.logging.logDir}`);
  console.log(`  Max file size: ${formatBytes(CONFIG.logging.maxLogFileSize)}`);
  console.log(`  Retention: ${CONFIG.logging.rotation.retentionDays} days`);
  console.log(`  Auto cleanup: ${CONFIG.logging.rotation.autoCleanup ? 'ON' : 'OFF'}`);
  console.log(`  Log files: ${stats.totalFiles} (${stats.totalSizeFormatted})`);
  console.log(`========================================\n`);
  console.log(`  SQL Monitor API:`);
  console.log(`  POST   /api/sql/monitor         - 上报单条 SQL`);
  console.log(`  POST   /api/sql/batch-monitor   - 批量上报 SQL`);
  console.log(`  GET    /api/sql/slow-queries    - 查询慢 SQL 日志`);
  console.log(`  Log Management API:`);
  console.log(`  GET    /api/logs/files          - 获取日志文件列表`);
  console.log(`  GET    /api/logs/stats          - 获取日志统计`);
  console.log(`  POST   /api/logs/cleanup        - 手动清理过期日志`);
  console.log(`  DELETE /api/logs/:filename      - 删除指定日志文件`);
  console.log(`\n  Statistics API:`);
  console.log(`  GET    /api/stats/by-table      - 按表分组慢查询统计`);
  console.log(`  GET    /api/stats/top-slow      - 最慢 SQL 排行榜`);
  console.log(`  POST   /api/utils/extract-tables- 解析 SQL 表名`);
  console.log(`\n  Config API:`);
  console.log(`  GET    /api/config              - 获取配置`);
  console.log(`  PUT    /api/config/threshold    - 修改慢查询阈值`);
  console.log(`  PUT    /api/config/retention    - 修改日志保留天数`);
  console.log(`\n  Health:`);
  console.log(`  GET    /health                  - 健康检查`);
  console.log(`\n========================================\n`);
});
