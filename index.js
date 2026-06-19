const express = require('express');
const CONFIG = require('./config');
const {
  ensureLogDirectory,
  formatLogEntry,
  writeToArchiveLog,
  readSlowQueries
} = require('./utils/archiveLogger');

const app = express();
const PORT = CONFIG.server.port;

let slowQueryThreshold = CONFIG.slowQuery.threshold;

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

  try {
    const parsedLogs = readSlowQueries(limit);
    res.json({
      success: true,
      data: parsedLogs
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
      maxLogFileSize: CONFIG.logging.maxLogFileSize
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

app.get('/health', (req, res) => {
  res.json({
    success: true,
    data: {
      status: 'running',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    }
  });
});

ensureLogDirectory();

app.listen(PORT, () => {
  console.log(`\n========================================`);
  console.log(`  SQL Monitor Service`);
  console.log(`========================================`);
  console.log(`  Server running on port ${PORT}`);
  console.log(`  Slow query threshold: ${slowQueryThreshold}ms`);
  console.log(`  Log directory: ${CONFIG.logging.logDir}`);
  console.log(`========================================\n`);
  console.log(`  POST   /api/sql/monitor         - 上报单条 SQL`);
  console.log(`  POST   /api/sql/batch-monitor   - 批量上报 SQL`);
  console.log(`  GET    /api/sql/slow-queries    - 查询慢 SQL 日志`);
  console.log(`  GET    /api/config              - 获取配置`);
  console.log(`  PUT    /api/config/threshold    - 修改阈值`);
  console.log(`  GET    /health                  - 健康检查`);
  console.log(`\n========================================\n`);
});
