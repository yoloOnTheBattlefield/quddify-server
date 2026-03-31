const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const logger = require("../utils/logger").child({ module: "storageService" });

const R2_ENDPOINT = "https://9c5193bf3a9854908c9ece70be00110b.r2.cloudflarestorage.com";
const BUCKET = "carousels";

const s3 = new S3Client({
  region: "auto",
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

async function upload(key, buffer, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
  }));
  logger.info(`Stored file: ${key}`);
  return key;
}

async function getPresignedUrl(key, expiresIn = 3600) {
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
    { expiresIn },
  );
  return url;
}

async function getBuffer(key) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const chunks = [];
  for await (const chunk of res.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function remove(key) {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
  logger.info(`Deleted file: ${key}`);
}

module.exports = { upload, getPresignedUrl, getBuffer, remove };
