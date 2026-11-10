import { seed } from './seed';

/** Seeds the database before any project runs, so the first account (the platform admin) is always the same one. */
export default async function globalSetup() {
  await seed();
}
