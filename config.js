const path = require('path');

module.exports = {
  server: {
    port: parseInt(process.env.PORT) || 3000
  },
  slowQuery: {
    threshold: parseInt(process.env.SLOW_QUERY_THRESHOLD) || 1000
  },
  logging: {
    logDir: path.join(__dirname, 'logs'),
    archiveLogFile: 'slow-queries-archive.log',
    maxLogFileSize: parseInt(process.env.MAX_LOG_FILE_SIZE) || 100 * 1024 * 1024,
    rotation: {
      enabled: true,
      datePattern: 'YYYY-MM-DD',
      maxFilesPerDay: 999,
      retentionDays: parseInt(process.env.LOG_RETENTION_DAYS) || 30,
      compressOldFiles: false,
      autoCleanup: true
    }
  }
};
