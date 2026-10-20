import { defineLibrary } from '../../vite.shared.ts';

export default defineLibrary({
  root: import.meta.url,
  entry: { cli: 'src/cli.ts', review: 'src/review.ts' },
});
