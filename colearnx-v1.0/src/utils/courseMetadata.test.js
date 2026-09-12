import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCourseMetadataUpdate, canEditCourseMetadata } from './courseMetadata.js';

const course = {
  id: 'course-one', kind: 'course', status: 'Draft', publicationStatus: 'Draft',
  categoryId: 'category-one', capacity: 24, startsAt: '2026-10-01T01:00:00Z', endsAt: '2026-10-01T02:00:00Z',
  timezone: 'Asia/Singapore', deliveryModes: ['live', 'cloud'],
  progressTrackingType: 'online_video', totalDurationSeconds: 1200,
};
const form = { title: ' Revised title ', description: ' Revised description ', pricePoints: '15', fulfilmentInstructions: ' Join the scheduled session ', trainerContact: ' Trainer contact ', joinUrl: 'https://meeting.example/session' };

test('course metadata editing preserves all server-owned scheduling and delivery configuration', () => {
  const input = buildCourseMetadataUpdate(course, form, ' Update metadata ');
  assert.equal(input.title, 'Revised title');
  assert.equal(input.description, 'Revised description');
  assert.equal(input.pricePoints, 15);
  assert.equal(input.changeSummary, 'Update metadata');
  for (const key of ['categoryId', 'capacity', 'startsAt', 'endsAt', 'timezone', 'progressTrackingType', 'totalDurationSeconds']) assert.equal(input[key], course[key]);
  assert.deepEqual(input.deliveryModes, ['live', 'cloud']);
  assert.notEqual(input.deliveryModes, course.deliveryModes);
  assert.equal(input.fulfilmentInstructions, 'Join the scheduled session');
  assert.equal(input.trainerContact, 'Trainer contact');
  assert.equal(input.joinUrl, 'https://meeting.example/session');
});

test('cloud-only metadata sends nullable delivery fields instead of invalid empty strings', () => {
  const cloud = { ...course, deliveryModes: ['cloud'], categoryId: null, capacity: null, startsAt: null, endsAt: null, timezone: null, progressTrackingType: 'none', totalDurationSeconds: null };
  const input = buildCourseMetadataUpdate(cloud, { ...form, fulfilmentInstructions: '', trainerContact: '', joinUrl: '' }, 'Update metadata');
  for (const field of ['fulfilmentInstructions', 'trainerContact', 'joinUrl', 'capacity', 'startsAt', 'endsAt', 'totalDurationSeconds']) assert.equal(input[field], null);
  assert.equal('categoryId' in input, false);
  assert.equal('timezone' in input, false);
  assert.deepEqual(input.deliveryModes, ['cloud']);
  assert.equal(input.progressTrackingType, 'none');
});

test('only draft course listings expose the supported metadata update', () => {
  assert.equal(canEditCourseMetadata(course), true);
  for (const override of [{ kind: 'content' }, { status: 'Submitted' }, { publicationStatus: 'Published' }, { publicationStatus: undefined }]) {
    assert.equal(canEditCourseMetadata({ ...course, ...override }), false);
    assert.throws(() => buildCourseMetadataUpdate({ ...course, ...override }, form, 'Update metadata'), /owned draft/);
  }
});

test('missing saved course fields fail closed instead of resetting configuration', () => {
  for (const field of ['categoryId', 'capacity', 'startsAt', 'endsAt', 'timezone', 'progressTrackingType', 'totalDurationSeconds', 'deliveryModes']) {
    assert.throws(() => buildCourseMetadataUpdate({ ...course, [field]: undefined }, form, 'Update metadata'), /incomplete/);
  }
  assert.throws(() => buildCourseMetadataUpdate({ ...course, totalDurationSeconds: null }, form, 'Update metadata'), /video configuration/);
});

test('metadata payload validates user edits without accepting empty prices or unsafe links', () => {
  for (const override of [{ title: ' ' }, { pricePoints: '' }, { pricePoints: '1.2' }, { pricePoints: '-1' }, { fulfilmentInstructions: '' }, { trainerContact: '' }, { joinUrl: 'javascript:alert(1)' }]) {
    assert.throws(() => buildCourseMetadataUpdate(course, { ...form, ...override }, 'Update metadata'));
  }
  assert.equal(buildCourseMetadataUpdate(course, { ...form, joinUrl: '' }, 'Update metadata').joinUrl, null);
});
