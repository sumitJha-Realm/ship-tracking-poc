const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const CURRENT_LEVEL = LOG_LEVELS[process.env.LOG_LEVEL] || LOG_LEVELS.INFO;

function timestamp() {
  return new Date().toISOString();
}

function debug(tag, message, data) {
  if (CURRENT_LEVEL <= LOG_LEVELS.DEBUG) {
    console.log(`[${timestamp()}] [DEBUG] [${tag}] ${message}`, data || '');
  }
}

function info(tag, message, data) {
  if (CURRENT_LEVEL <= LOG_LEVELS.INFO) {
    console.log(`[${timestamp()}] [INFO]  [${tag}] ${message}`, data || '');
  }
}

function warn(tag, message, data) {
  if (CURRENT_LEVEL <= LOG_LEVELS.WARN) {
    console.warn(`[${timestamp()}] [WARN]  [${tag}] ${message}`, data || '');
  }
}

function error(tag, message, data) {
  if (CURRENT_LEVEL <= LOG_LEVELS.ERROR) {
    console.error(`[${timestamp()}] [ERROR] [${tag}] ${message}`, data || '');
  }
}

module.exports = { debug, info, warn, error };
