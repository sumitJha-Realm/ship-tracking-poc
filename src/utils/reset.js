const { connect, getCollection, getTimeseriesCollection, disconnect, COLLECTION_NAME, CTRACK_DB_NAME, TIMESERIES_COLLECTION } = require('./db');
const logger = require('./logger');

async function resetDatabase() {
  try {
    await connect();

    // 1. Drop ship_tracking.ctrack_data
    const ctrackCol = await getCollection();
    logger.info('RESET', `Dropping ship_tracking.${COLLECTION_NAME}...`);
    await ctrackCol.drop().catch(() => {
      logger.warn('RESET', `  ${COLLECTION_NAME} did not exist`);
    });

    // 2. Drop CTRACK.tracks_local_timeseries
    const tsCol = await getTimeseriesCollection();
    logger.info('RESET', `Dropping ${CTRACK_DB_NAME}.${TIMESERIES_COLLECTION}...`);
    await tsCol.drop().catch(() => {
      logger.warn('RESET', `  ${TIMESERIES_COLLECTION} did not exist`);
    });

    logger.info('RESET', 'Database reset complete (both collections dropped)');
  } catch (error) {
    logger.error('RESET', 'Reset failed:', error.message);
  } finally {
    await disconnect();
  }
}

resetDatabase();
