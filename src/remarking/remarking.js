const { connect, getCollection, disconnect } = require('../utils/db');
const logger = require('../utils/logger');

/**
 * Add a remark for a user on a ship
 */
async function addRemark(suid, userId) {
  const collection = await getCollection();
  const result = await collection.updateOne(
    { suid },
    { $addToSet: { CtrackRemarksUserIDs: userId } }
  );
  return result.modifiedCount > 0;
}

/**
 * Remove a remark for a user on a ship
 */
async function removeRemark(suid, userId) {
  const collection = await getCollection();
  const result = await collection.updateOne(
    { suid },
    { $pull: { CtrackRemarksUserIDs: userId } }
  );
  return result.modifiedCount > 0;
}

/**
 * Check if a user has remarked a ship
 */
async function hasRemark(suid, userId) {
  const collection = await getCollection();
  const doc = await collection.findOne(
    { suid, CtrackRemarksUserIDs: userId },
    { projection: { _id: 1 } }
  );
  return !!doc;
}

/**
 * Get all ships remarked by a user
 */
async function getRemarksByUser(userId, limit = 100) {
  const collection = await getCollection();
  return collection
    .find({ CtrackRemarksUserIDs: userId })
    .project({ _id: 0, suid: 1, ship_name: 1, nationality: 1, reported_time_info: 1 })
    .limit(limit)
    .toArray();
}

/**
 * Add Track of Interest for a user
 */
async function addTOI(suid, userId) {
  const collection = await getCollection();
  const result = await collection.updateOne(
    { suid },
    { $addToSet: { TOIUserIds: userId } }
  );
  return result.modifiedCount > 0;
}

/**
 * Remove Track of Interest for a user
 */
async function removeTOI(suid, userId) {
  const collection = await getCollection();
  const result = await collection.updateOne(
    { suid },
    { $pull: { TOIUserIds: userId } }
  );
  return result.modifiedCount > 0;
}

/**
 * Get all ships marked as TOI by a user
 */
async function getTOIByUser(userId, limit = 100) {
  const collection = await getCollection();
  return collection
    .find({ TOIUserIds: userId })
    .project({ _id: 0, suid: 1, ship_name: 1, nationality: 1, reported_time_info: 1 })
    .limit(limit)
    .toArray();
}

module.exports = {
  addRemark,
  removeRemark,
  hasRemark,
  getRemarksByUser,
  addTOI,
  removeTOI,
  getTOIByUser,
};
