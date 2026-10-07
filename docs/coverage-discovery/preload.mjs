import { dump } from './capture.mjs';
process.on('exit', dump);
