import { z } from 'zod';
import { uuid } from '../lib/validation.js';

export const refundRequestSchema = z.object({
  orderItemId: uuid,
  reason: z.string().trim().min(3, 'Enter at least 3 characters for the refund reason.')
    .max(2000, 'The refund reason must be no more than 2000 characters.'),
});
