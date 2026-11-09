'use strict';
const assert = require('assert');
const sharp = require('sharp');
const { loadPicture, renderPicture } = require('../server/pics-maker');
(async()=>{
 const bytes=await sharp({create:{width:200,height:100,channels:3,background:'#357'}}).png().toBuffer();
 const calls=[];const ctx={sso:{client:{extractToken:()=> 'test-person'}},fetchImpl:async(url,o)=>{calls.push([url,o]);return url.endsWith('/bytes')?new Response(bytes):new Response(JSON.stringify({bytes:bytes.length,width:200,height:100,mime_type:'image/png'}));}};
 const picture=await loadPicture(ctx,{},'Abcdef23');assert.equal(calls.length,2);assert.equal(calls[0][1].redirect,'error');
 const rendered=await renderPicture(picture,['Hello','World']);assert.equal((await sharp(rendered.png).metadata()).format,'png');
 await assert.rejects(loadPicture(ctx,{},'https://evil.test'));process.stdout.write('Pics maker validates source and renders a PNG\n');
})().catch(e=>{process.stderr.write(e.stack+'\n');process.exit(1);});
