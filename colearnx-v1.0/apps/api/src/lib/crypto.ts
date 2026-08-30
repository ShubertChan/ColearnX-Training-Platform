import { createHash, randomBytes } from 'node:crypto';

export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const createOpaqueToken = () => randomBytes(48).toString('base64url');
