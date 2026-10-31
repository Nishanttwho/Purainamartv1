import fs from 'node:fs/promises';
// Extract only committed modules for performance comparisons. Never check out,
// reset, or initialize a database. Remove tmp/performance-baseline after use.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const root=path.resolve('tmp/performance-baseline');
const files=execFileSync('git',['ls-tree','-r','--name-only','HEAD','lib'],{encoding:'utf8'}).trim().split('\n');
for(const file of files){const target=path.join(root,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,execFileSync('git',['show','HEAD:'+file]));}
console.log(`Extracted ${files.length} original modules for isolated comparison; working tree untouched.`);
