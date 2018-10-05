const S3 = require('aws-sdk/clients/s3');
const url = require('url');
const jwt = require('jsonwebtoken');

const validEventTypes = ['resume', 'suspend'];
const validSuspendEventReasons = ['pause', 'skip', 'complete', 'system'];

const iso8601DateRegex = /^\d{4}-\d{2}-\d{2}$/;
const iso8601DateTimeRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6}|)(((\+|-)\d{2}:\d{2})|Z)$/;
const speedRegex = /^-|\d{1,}\.\d{1,}$/;
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const { SECRET: secret, BUCKET: bucket } = process.env;

if (secret === undefined || secret === '') {
  const error = new Error('`SECRET` environment variable is required to generate tokens');
  throw error;
}

if (bucket === undefined || bucket === '') {
  const error = new Error('`BUCKET` environment variable is required to store incoming requests');
  throw error;
}

const s3 = new S3();

function assertRequiredProperties(properties) {
  const missingProperty = Object
    .keys(properties)
    .find(property => properties[property] === undefined || properties[property] === '');
  if (missingProperty) {
    const error = new Error(`'${missingProperty}' property is required`);
    throw error;
  }
}

function parseEvent(event) {
  const { event: type, date, offset } = event;
  let parsedEvent = { event: type, date, offset };
  assertRequiredProperties(parsedEvent);

  const isValidEventType = validEventTypes.includes(type);
  if (!isValidEventType) {
    const error = new Error('`event` must be of type \'resume\' or \'suspend\'');
    throw error;
  }

  const isValidDateTime = iso8601DateTimeRegex.test(date);
  if (!isValidDateTime) {
    const error = new Error('`date` must be a valid ISO 8601 date/time string');
    throw error;
  }

  switch (type) {
    case 'resume': {
      const { speed = '1.0', loudness = false, gap_removal: gapRemoval = false } = event;
      const isValidSpeed = speedRegex.test(speed);
      if (!isValidSpeed) {
        const error = new Error('`speed` must be a valid number to 1 decimal place');
        throw error;
      }
      const isValidLoudness = typeof loudness === 'boolean';
      if (!isValidLoudness) {
        const error = new Error('`loudness` must be a boolean or not set');
        throw error;
      }
      const isValidGapRemoval = typeof gapRemoval === 'boolean';
      if (!isValidGapRemoval) {
        const error = new Error('`gap_removal` must be a boolean or not set');
        throw error;
      }
      parsedEvent = {
        ...parsedEvent,
        speed: parseInt(speed, 10),
        loudness,
        gap_removal: gapRemoval,
      };
      break;
    }
    case 'suspend': {
      const { reason } = event;
      if (!validSuspendEventReasons.includes(reason)) {
        const error = new Error('`reason` must be either \'pause\', \'complete\', \'skip\' or \'system\'');
        throw error;
      }
      parsedEvent = { ...parsedEvent, reason };
      break;
    }
    default: {
      break;
    }
  }

  return parsedEvent;
}

function parseEvents(events) {
  if (!Array.isArray(events) || events.length === 0 || events.length > 100) {
    const error = new Error('`events` property must be an array with at least 1 and no more than 100 events');
    throw error;
  }
  return events.map(parseEvent);
}

function parseListener({
  date_of_birth: dateOfBirth, location, current_location: currentLocation,
}) {
  if (dateOfBirth !== undefined && !iso8601DateRegex.test(dateOfBirth)) {
    const error = new Error('`date_of_birth` property must be ISO 8601 date format');
    throw error;
  }

  if (location !== undefined) {
    const { latitude: locationLatitude, longitude: locationLongitude } = location;
    try {
      assertRequiredProperties({ latitude: locationLatitude, longitude: locationLongitude });
    } catch (assertionError) {
      const error = new Error(`Invalid 'location' property: ${assertionError.message}`);
      throw error;
    }
    const areValuesValid = (
      !Number.isNaN(parseFloat(locationLatitude)) &&
      !Number.isNaN(parseFloat(locationLongitude))
    );
    if (!areValuesValid) {
      const error = new Error('`location` property values must be floats');
      throw error;
    }
  }

  if (currentLocation !== undefined) {
    const { latitude: currentLatitude, longitude: currentLongitude } = currentLocation;
    try {
      assertRequiredProperties({ latitude: currentLatitude, longitude: currentLongitude });
    } catch (assertionError) {
      const error = new Error(`Invalid 'current_location' property: ${assertionError.message}`);
      throw error;
    }
    const areValuesValid = (
      !Number.isNaN(parseFloat(currentLatitude)) &&
      !Number.isNaN(parseFloat(currentLongitude))
    );
    if (!areValuesValid) {
      const error = new Error('`current_location` property values must be floats');
      throw error;
    }
  }

  const parsedListener = {
    date_of_birth: dateOfBirth,
    location,
    current_location: currentLocation,
  };

  return parsedListener;
}

function assertListenerToken(token, uuid) {
  let decoded;
  try {
    decoded = jwt.verify(token, secret);
  } catch (jwtError) {
    const error = new Error('Listener token is invalid');
    throw error;
  }
  const { sub } = decoded;
  if (sub !== uuid) {
    const error = new Error('Listener token is invalid');
    throw error;
  }
}

function parseRequest(body = {}) {
  const {
    uuid,
    content,
    events,
    listener,
    listener_token: listenerToken,
  } = JSON.parse(body);
  assertRequiredProperties({ uuid, content, events });

  const isValidUUID = uuidRegex.test(uuid);
  if (!isValidUUID) {
    const error = new Error('`uuid` must be a valid UUIDv4');
    throw error;
  }

  const { protocol, host, path } = url.parse(content);
  const isValidContentURL = (protocol !== null && host !== null && path !== null);
  if (!isValidContentURL) {
    const error = new Error('`content` must be a valid URL');
    throw error;
  }

  if (listenerToken) {
    assertListenerToken(listenerToken, uuid);
  }

  const parsedRequest = {
    uuid,
    content,
    events: parseEvents(events),
    listener: listener !== undefined ? parseListener(listener) : undefined,
    listener_token: listenerToken,
  };

  return parsedRequest;
}

async function uploadToS3(parsedRequest) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const date = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getUTCHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const second = String(now.getSeconds()).padStart(2, '0');
  const { uuid } = parsedRequest;
  const id = uuid.split('-', 1);
  const key = `${year}-${month}-${date}-${hour}:${minute}:${second}-${id}.json`;

  const params = {
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(parsedRequest),
  };
  await s3.putObject(params).promise();
}

function buildResponse(statusCode, message, additionalValues = {}) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ...additionalValues, status: message }),
  };
}

module.exports.handler = async ({ httpMethod, body }) => {
  if (httpMethod !== 'POST') {
    return { statusCode: 405, headers: { 'Content-Type': '', Allow: 'POST' } };
  }
  if (body === null) {
    return buildResponse(400, 'Body must be a valid JSON object');
  }

  let parsedRequest;
  try {
    parsedRequest = parseRequest(body);
  } catch ({ message }) {
    return buildResponse(400, message);
  }

  try {
    await uploadToS3(parsedRequest);
  } catch (error) {
    console.error(error);
    return buildResponse(500, 'Sorry, there was a server side problem storing this pingback');
  }

  const { listener, listener_token: listenerToken } = parsedRequest;
  const shouldGenerateListenerToken = (listener !== undefined && listenerToken === undefined);
  let additionalValues;
  if (shouldGenerateListenerToken) {
    const { uuid } = parsedRequest;
    const responseListenerToken = jwt.sign({ uuid }, secret);
    additionalValues = { listener_token: responseListenerToken };
  }

  return buildResponse(201, 'ok', additionalValues);
};
