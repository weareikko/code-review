import { defineLibrary } from '../../vite.shared.ts';

export default defineLibrary({
  root: import.meta.url,
  entry: { index: 'src/index.ts' },
});
