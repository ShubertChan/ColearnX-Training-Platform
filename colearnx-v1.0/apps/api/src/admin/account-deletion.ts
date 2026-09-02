export const deletedAccountDisplayName = 'Deleted account';

export function deletedAccountEmail(userId: string) {
  return `deleted+${userId}@deleted.invalid`;
}
