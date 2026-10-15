import test from 'node:test';
import assert from 'node:assert/strict';
import {analysisProxy} from '../worker/analysis-proxy.js';
const env={ANALYSIS_URL:'https://analytics.wasmer.app',ANALYSIS_BEARER_TOKEN:'server-only-credential',ANALYSIS_WORKSPACE_SIGNING_KEY:'separate-cookie-signing-credential'};
test('Hosted analytical workspaces persist through signed cookies and ignore browser-supplied identities',async()=>{
 const calls=[];
 const backend=async(url,options)=>{calls.push({url,options});return Response.json({status:'ready'});};
 const first=await analysisProxy(new Request('https://site.test/api/analysis/health'),env,backend);
 const cookie=first.headers.get('Set-Cookie');assert.match(cookie,/HttpOnly; Secure/);
 const scope=calls[0].options.headers.get('X-Geobound-Workspace');
 const next=await analysisProxy(new Request('https://site.test/api/analysis/studies',{headers:{Cookie:cookie.split(';')[0],'X-Geobound-Workspace':'browser-spoof'}}),env,backend);
 assert.equal(next.headers.get('Set-Cookie'),null);
 assert.equal(calls[1].options.headers.get('X-Geobound-Workspace'),scope);
 assert.equal(calls[1].options.headers.get('Authorization'),'Bearer '+env.ANALYSIS_BEARER_TOKEN);
 assert.equal(calls[1].options.redirect,'manual');
 const forged=cookie.split(';')[0].replace(scope,crypto.randomUUID());
 await analysisProxy(new Request('https://site.test/api/analysis/studies',{headers:{Cookie:forged}}),env,backend);
 assert.notEqual(calls[2].options.headers.get('X-Geobound-Workspace'),scope);
 assert.ok(!(await next.text()).includes(env.ANALYSIS_BEARER_TOKEN));
});
test('Browser proxy rejects worker execution and redirects',async()=>{
 let calls=0;
 const upstream=async()=>{calls++;return new Response(null,{status:302,headers:{Location:'https://unlisted.test'}});};
 assert.equal((await analysisProxy(new Request('https://site.test/api/analysis/internal/execute/job'),env,upstream)).status,403);
 assert.equal(calls,0);
 assert.equal((await analysisProxy(new Request('https://site.test/api/analysis/studies'),env,upstream)).status,502);
});
