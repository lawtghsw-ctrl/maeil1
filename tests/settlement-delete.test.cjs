const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
const vm=require('node:vm');
const source=fs.readFileSync('components/store.tsx','utf8');
const expected={kind:'payment',settlement:{id:'settlement-id',amount:100000},payment:{id:'payment',row_version:7},source:null};
const requestKey='11111111-2222-4333-8444-555555555555';
const ast=ts.createSourceFile('store.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function deletion(rpc,refresh){let found;function visit(node){if(ts.isMethodDeclaration(node)&&node.name.getText(ast)==='deleteSettlement')found=node;ts.forEachChild(node,visit)}visit(ast);assert.ok(found);return vm.runInNewContext(`(${found.getText(ast).replace('async deleteSettlement(','async function(')})`,{Error,supabase:{rpc,from(){throw Error('Source rows must not be written')}},refresh})}

test('settlement deletion uses its dedicated RPC and waits before refreshing',async()=>{
 let finish,sent,refreshed=0;
 const remove=deletion((name,args)=>{sent={name,args};return new Promise(resolve=>{finish=resolve})},async()=>{refreshed++});
 const pending=remove('settlement-id',expected,requestKey);assert.equal(typeof pending.then,'function');assert.equal(refreshed,0);assert.equal(sent.name,'dowon_cancel_settlement');assert.deepEqual(JSON.parse(JSON.stringify(sent.args)),{p_id:'settlement-id',p_expected:expected,p_request_key:requestKey});
 finish({error:null,data:{cancelled:true}});await pending;assert.equal(refreshed,1);
});

test('legacy refund display IDs lose only their UI prefix before the UUID RPC',async()=>{
 let sent,refreshed=0;const refundId='11111111-2222-4333-8444-555555555555';
 const remove=deletion(async(name,args)=>{sent={name,args};return {error:null,data:{cancelled:true}}},async()=>{refreshed++});
 await remove('refund:'+refundId,expected,requestKey);assert.equal(sent.name,'dowon_cancel_settlement');assert.equal(sent.args.p_id,refundId);assert.equal(refreshed,1);
});

for(const transport of [false,true])test('settlement deletion '+(transport?'transport':'database')+' failure stays observable and does not refresh',async()=>{
 let refreshed=0;const remove=deletion(async()=>{if(transport)throw Error('offline');return {error:{message:'rejected'}}},async()=>{refreshed++});
 await assert.rejects(remove('settlement-id',expected,requestKey),transport?/offline/:/rejected/);assert.equal(refreshed,0);
});


test('settlement cancellation rejects calls without a fixed snapshot or retry key before any RPC',async()=>{
 let calls=0;const remove=deletion(async()=>{calls++;return {error:null,data:{cancelled:true}}},async()=>{});
 await assert.rejects(remove('id'),/확인 정보/);await assert.rejects(remove('id',expected,''),/확인 정보/);assert.equal(calls,0);
});
test('a missing cancellation acknowledgement is not reported as a successful source cancellation',async()=>{
 let refreshed=0;const remove=deletion(async()=>({error:null,data:{}}),async()=>{refreshed++});
 await assert.rejects(remove('id',expected,requestKey),/결과를 확인하지 못/);assert.equal(refreshed,0);
});

test('transport failure retries preserve the source snapshot and request UUID without re-reading or hiding a source',async()=>{
 const calls=[];let refreshed=0;const remove=deletion(async(name,args)=>{calls.push({name,args});if(calls.length===1)throw Error('response lost');return {error:null,data:{cancelled:true}}},async()=>{refreshed++});
 await assert.rejects(remove('id',expected,requestKey),/response lost/);await remove('id',expected,requestKey);
 assert.equal(calls[0].name,'dowon_cancel_settlement');assert.equal(calls[1].args.p_expected,expected);assert.equal(calls[1].args.p_request_key,requestKey);assert.equal(refreshed,1);
});
