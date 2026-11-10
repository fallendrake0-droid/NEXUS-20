'use strict';

const { BoundedLogger } = require('../performance/BoundedLogger');

/**
 * Structured logging system wrapping Stage-0 `BoundedLogger` (zero duplication).
 * Provides child component/request loggers, automatic secret redaction, duplicate
 * error suppression, bounded memory ring, and `5 MiB × 3` JSONL rotation.
 */
function createChildFacade(rootLogger, baseFields = {}) {
  const mergeMeta = (meta) => {
    if (!meta || typeof meta !== 'object') return { ...baseFields };
    return { ...baseFields, ...meta };
  };

  return {
    debug(msg, meta) {
      return rootLogger.debug(msg, mergeMeta(meta));
    },
    info(msg, meta) {
      return rootLogger.info(msg, mergeMeta(meta));
    },
    warn(msg, meta) {
      return rootLogger.warn(msg, mergeMeta(meta));
    },
    error(msg, meta) {
      return rootLogger.error(msg, mergeMeta(meta));
    },
    child(extraFields = {}) {
      return createChildFacade(rootLogger, { ...baseFields, ...extraFields });
    },
    setLevel(level) {
      rootLogger.setLevel(level);
    },
    recentEntries(limit = 50) {
      return rootLogger.recentLines(limit).map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
    },
    stats() {
      return rootLogger.stats();
    }
  };
}

function createLogger(options = {}) {
  const root =
    options.boundedLogger instanceof BoundedLogger
      ? options.boundedLogger
      : new BoundedLogger({
          level: options.level || 'info',
          ringSize: options.ringSize || 200,
          filePath: options.filePath || null,
          maxFileBytes: options.maxFileBytes || 5 * 1024 * 1024,
          maxFiles: options.maxFiles || 3,
          dedupWindowMs: options.dedupWindowMs
        });

  return createChildFacade(root, options.defaultFields || {});
}

module.exports = { createLogger };
