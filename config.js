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
    maxLogFileSize: 10 * 1024 * 1024
  }
};
