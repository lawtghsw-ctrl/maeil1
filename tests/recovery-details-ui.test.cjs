const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const jsx=require('react/jsx-runtime');

const source=ts.transpileModule(fs.readFileSync('components/customer-finance-modals.tsx','utf8'),{
 compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX},
}).outputText;
const legacy={id:'old',customerId:'customer',createdTime:'2026-01-01',recoveryDate:'2026-10-01',lenderName:'가상 업체',depositorName:'가상 입금자',recoveryType:'기존 사유 보존',amount:100000,paymentMethod:'계좌이체',memo:'기존 메모',rowVersion:7};
function screen(patch={}){
 const state=[],calls=[],effects=[],effectDeps=[];let cursor=0,closed=0;
 const store={recoveries:[],recoverySplits:[],recoveryRefunds:[],lenders:[],setCustomerRecoveries:async(customerId,rows,versions)=>{calls.push({customerId,rows:JSON.parse(JSON.stringify(rows)),versions:JSON.parse(JSON.stringify(versions))})},...patch};
 const react={
  useState(initial){const i=cursor++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;return [state[i],next=>{state[i]=typeof next==='function'?next(state[i]):next}]},
  useRef(initial){const i=cursor++;return state[i]??={current:initial}},
  useEffect(effect,deps){const i=cursor++,before=effectDeps[i];if(!before||deps.some((value,index)=>value!==before[index])){effectDeps[i]=deps;effects.push(effect)}},useMemo(fn){return fn()},
 };
 const exports={};
 vm.runInNewContext(source,{exports,Intl,Number,Math,Error,window:{confirm:()=>true},require(name){
  if(name==='react')return react;if(name==='react/jsx-runtime')return jsx;
  if(name==='lucide-react')return {Plus:'Plus',Trash2:'Trash2'};
  if(name==='@/components/ui')return {Modal:'Modal',Card:'Card',Badge:'Badge',Button:'Button'};
  if(name==='@/components/store')return {useAdminStore:()=>store};
  if(name==='@/lib/utils')return {won:value=>`₩${value.toLocaleString('ko-KR')}`};
  throw Error(name);
 }});
 const props={open:true,customer:{id:'customer',name:'가상 고객'},onClose:()=>{closed++}};
 return {store,calls,closed:()=>closed,render(){cursor=0;const tree=exports.RecoveriesModal(props);effects.splice(0).forEach(effect=>effect());return tree}};
}
function findAll(node,predicate,result=[]){
 if(!node||typeof node!=='object')return result;
 if(Array.isArray(node)){for(const child of node)findAll(child,predicate,result);return result}
 if(predicate(node))result.push(node);
 findAll(node.props?.children,predicate,result);return result;
}
function text(node){if(node===null||node===undefined||typeof node==='boolean')return '';if(typeof node!=='object')return String(node);if(Array.isArray(node))return node.map(text).join('');return text(node.props?.children)}
const button=(tree,label)=>findAll(tree,node=>(node.type==='Button'||node.type==='button')&&text(node)===label)[0];
const field=(tree,label)=>findAll(tree,node=>node.type?.name==='Label'&&node.props.text===label)[0]?.props.children;
function edit(page,label,value){const input=field(page.render(),label);assert.ok(input,`missing field ${label}`);input.props.onChange(input.type?.name==='NumberInput'?value:{target:{value}})}
function add(page){button(page.render(),'+ 환수 건 추가').props.onClick()}
function completeNew(page,amount=100000){add(page);edit(page,'환수일','2026-10-19');edit(page,'실제 입금 예금주','새 입금자');edit(page,'환수 금액',amount)}

test('recovery detail replaces the split panel and keeps untouched legacy cash metadata',async()=>{
 const page=screen({recoveries:[legacy],recoverySplits:[{recoveryId:'old',appliedFee:10000}],recoveryRefunds:[{recoveryId:'old',amount:5000}]});
 const tree=page.render();
 for(const label of ['환수일','업체명','실제 입금 예금주','환수 금액','환수 성공보수 (50% 자동)','환수 분납금','의뢰인 환수 반환금 (출금)'])assert.ok(field(tree,label));
 assert.equal(field(tree,'환수 구분 / 사유'),undefined);
 assert.doesNotMatch(text(tree),/환수금 성공보수 \/ 분납 충당|분배 확정 저장|분배할 환수 선택/);
 assert.equal(field(tree,'환수 성공보수 (50% 자동)').props.readOnly,true);
 assert.equal(field(tree,'환수 분납금').props.value,10000);
 assert.equal(field(tree,'의뢰인 환수 반환금 (출금)').props.value,5000);
 await button(tree,'저장').props.onClick();
 assert.equal(page.calls[0].rows[0].accountingVersion,1);
 assert.equal(page.calls[0].rows[0].rowVersion,7);
 assert.equal(page.calls[0].rows[0].recoveryType,'기존 사유 보존');
 assert.equal(page.closed(),1);
});

test('recovery guidance describes one gross bank receipt and preserves separate return outflows without presenting allocations as extra deposits',()=>{
 const page=screen({recoveries:[legacy]});const content=text(page.render());
 assert.match(content,/환수 총액은 로펌 정산표에 실제 입금 1건으로 반영/);
 assert.match(content,/성공보수 50%와 환수 분납금은 매출 분류/);
 assert.match(content,/의뢰인 반환금은 기존 반환 이력과 중복되지 않도록 별도 출금으로 반영/);
 assert.doesNotMatch(content,/성공보수·분납금은 입금|성공보수와 분납금은 입금|성공보수·분납금.*입금.*환수일의 정산표/);
});

test('actual edits convert only the selected recovery and automatically recompute half the gross amount',async()=>{
 const page=screen({recoveries:[legacy,{...legacy,id:'other',createdTime:'2026-01-02'}]});
 edit(page,'환수 금액',100001);
 edit(page,'환수 분납금',30000);edit(page,'의뢰인 환수 반환금 (출금)',20000);
 assert.equal(field(page.render(),'환수 성공보수 (50% 자동)').props.value,'50,000');
 await button(page.render(),'저장').props.onClick();
 const [changed,untouched]=page.calls[0].rows;
 assert.equal(changed.accountingVersion,2);assert.equal(changed.successFeeAmount,50000);
 assert.equal(changed.installmentAmount,30000);assert.equal(changed.clientReturnAmount,20000);
 assert.equal(changed.rowVersion,7);assert.equal(untouched.accountingVersion,1);
});

test('same-value input and realtime store refresh cannot convert or erase a legacy draft',async()=>{
 const page=screen({recoveries:[legacy]});
 edit(page,'업체명',legacy.lenderName);
 page.store.recoveries=[{...legacy,lenderName:'다른 편집자의 업체'}];
 assert.equal(field(page.render(),'업체명').props.value,legacy.lenderName);
 await button(page.render(),'저장').props.onClick();
 assert.equal(page.calls[0].rows[0].accountingVersion,1);
});

test('new zero recovery is saved without inventing allocation or return amounts',async()=>{
 const page=screen();add(page);await button(page.render(),'저장').props.onClick();
 const row=page.calls[0].rows[0];
 assert.equal(row.accountingVersion,2);assert.equal(row.amount,0);assert.equal(row.successFeeAmount,0);
 assert.equal(row.installmentAmount,0);assert.equal(row.clientReturnAmount,0);
});

test('manual allocation and return inputs are preserved when gross recovery changes',()=>{
 const page=screen();completeNew(page);
 edit(page,'환수 분납금',30000);edit(page,'의뢰인 환수 반환금 (출금)',20000);edit(page,'환수 금액',80000);
 const tree=page.render();assert.equal(field(tree,'환수 성공보수 (50% 자동)').props.value,'40,000');
 assert.equal(field(tree,'환수 분납금').props.value,30000);assert.equal(field(tree,'의뢰인 환수 반환금 (출금)').props.value,20000);
});

test('over-distribution and positive recovery without a depositor fail before a request',async()=>{
 const page=screen();add(page);edit(page,'환수 금액',100000);await button(page.render(),'저장').props.onClick();
 assert.match(text(page.render()),/실제 입금 예금주를 입력/);assert.equal(page.calls.length,0);
 edit(page,'실제 입금 예금주','가상 입금자');edit(page,'환수 분납금',30000);edit(page,'의뢰인 환수 반환금 (출금)',20001);
 await button(page.render(),'저장').props.onClick();
 assert.match(text(page.render()),/초과할 수 없습니다/);assert.equal(page.calls.length,0);assert.equal(page.closed(),0);
});

test('pending saves block duplicate requests and closing, then retain edited amounts on failure',async()=>{
 let reject,calls=0;
 const page=screen({setCustomerRecoveries:()=>{calls++;return new Promise((resolve,fail)=>{reject=fail})}});
 completeNew(page);edit(page,'환수 분납금',30000);edit(page,'의뢰인 환수 반환금 (출금)',20000);
 const initial=page.render(),pending=button(initial,'저장').props.onClick();
 await button(initial,'저장').props.onClick();initial.props.onClose();
 assert.equal(calls,1);assert.equal(page.closed(),0);
 const waiting=page.render();assert.equal(button(waiting,'저장 중...').props.disabled,true);
 assert.equal(findAll(waiting,node=>node.type==='fieldset')[0].props.disabled,true);
 edit(page,'환수 분납금',0);reject(Error('network interrupted'));await pending;
 const failed=page.render();assert.match(text(failed),/network interrupted/);
 assert.equal(field(failed,'환수 분납금').props.value,30000);
 assert.equal(field(failed,'의뢰인 환수 반환금 (출금)').props.value,20000);
 assert.equal(page.closed(),0);assert.equal(button(failed,'저장').props.disabled,false);
});

test('deleting a selected recovery leaves other records and their accounting versions intact',async()=>{
 const page=screen({recoveries:[legacy,{...legacy,id:'other',createdTime:'2026-01-02'}]});
 button(page.render(),'삭제').props.onClick();await button(page.render(),'저장').props.onClick();
 assert.equal(page.calls[0].rows.length,1);assert.equal(page.calls[0].rows[0].id,'other');
 assert.equal(page.calls[0].rows[0].accountingVersion,1);
});

test('deleting an edited recovery after realtime changes keeps the original version snapshot and excludes unseen new rows',async()=>{
 const page=screen({recoveries:[legacy]});page.render();
 page.store.recoveries=[{...legacy,rowVersion:8},{...legacy,id:'concurrently-added',rowVersion:1}];
 button(page.render(),'삭제').props.onClick();await button(page.render(),'저장').props.onClick();
 assert.equal(page.calls[0].rows.length,0);assert.deepEqual(page.calls[0].versions,{old:7});
 assert.equal(page.store.recoveries.length,2);assert.equal(page.store.recoveries[1].id,'concurrently-added');
});
