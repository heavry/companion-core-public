import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {extractLocalPaths,hydrateLocalResources,readLocalImage,localResourceScope} from '../src/local-resource-resolver.js';
const root=fs.mkdtempSync(path.join(os.homedir(),'Downloads/companion-resource-test-'));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==','base64');
try{
  const image=path.join(root,'a space.png');fs.writeFileSync(image,png);
  assert.deepEqual(extractLocalPaths('看看 `/Users/example/Desktop/a.png` 和 ~/Downloads/b.jpeg'),['/Users/example/Desktop/a.png','~/Downloads/b.jpeg']);
  assert.deepEqual(extractLocalPaths(`看一下 "${image}"`),[image]);
  const messages=[{role:'user',content:`"${image}"`}],before=JSON.stringify(messages);
  const hydrated=await hydrateLocalResources(messages,messages[0].content);
  assert.equal(JSON.stringify(messages),before);
  assert.ok(hydrated.messages.at(-1).content.some(p=>p.image_url?.url.startsWith('data:image/png;base64,')));
  assert.throws(()=>readLocalImage('/Users/example/Downloads/does-not-exist.png'),e=>e.code==='LOCAL_PATH_NOT_FOUND');
  fs.writeFileSync(path.join(root,'fake.png'),'not an image');assert.throws(()=>readLocalImage(path.join(root,'fake.png')),e=>e.code==='LOCAL_IMAGE_INVALID');
  fs.writeFileSync(path.join(root,'.env'),'secret');fs.symlinkSync(path.join(root,'.env'),path.join(root,'pretend.txt'));
  assert.throws(()=>localResourceScope([root])(path.join(root,'pretend.txt')),e=>e.code==='LOCAL_SENSITIVE_PATH_BLOCKED');
  assert.throws(()=>localResourceScope([image])(path.join(root,'fake.png')),e=>e.code==='LOCAL_PATH_SCOPE_DENIED');
  console.log('PASS local resource paths, spaces, image bytes, missing path, sensitive symlink, grants, transient-only data');
}finally{fs.rmSync(root,{recursive:true,force:true});}
