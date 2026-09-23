// Refresh only IT; does not change HR/Product or the employee directory.
import { loadEnv } from './_load-env.mjs';
loadEnv();
const { prepareITSnapshot, writeITSnapshot, getITBundle } = await import('../src/kb/it.js');
const snapshot = await prepareITSnapshot();
console.log(JSON.stringify({ collectionId: snapshot.collectionId, documents: snapshot.docs.length,
  refreshedAt: snapshot.refreshedAt, titles: snapshot.docs.map(d => d.title) }, null, 2));
if (process.argv.includes('--write')) {
  await writeITSnapshot(snapshot);
  if (!(await getITBundle())) throw new Error('IT cache read-back failed');
  console.log('IT snapshot saved and read-back verified');
} else console.log('Read-only validation; pass --write to refresh IT cache');
