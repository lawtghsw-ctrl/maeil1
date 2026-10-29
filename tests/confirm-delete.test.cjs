const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const ts=require('typescript');
const jsx=require('react/jsx-runtime');

function component(props){
 const values=[];let cursor=0;
 const react={useState(initial){const index=cursor++;if(!(index in values))values[index]=initial;return [values[index],value=>{values[index]=typeof value==='function'?value(values[index]):value}]},useRef(initial){const index=cursor++;return values[index]??=( {current:initial} )}};
 const exports={};
 const source=ts.transpileModule(fs.readFileSync('components/confirm-delete.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 vm.runInNewContext(source,{exports,Error,require(name){if(name==='react')return react;if(name==='react/jsx-runtime')return jsx;if(name==='@/components/ui')return {Modal:'Modal',Button:'Button'};throw Error(name)}});
 return ()=>{cursor=0;return exports.ConfirmDelete(props)};
}
function find(node,predicate){if(!node||typeof node!=='object')return; if(predicate(node))return node;for(const child of [node.props?.children].flat()){const found=find(child,predicate);if(found)return found}}
const confirmButton=tree=>find(tree,node=>node.type==='Button'&&node.props.variant==='danger');

test('delete confirmation waits for completion and blocks duplicate requests and closing while pending',async()=>{
 let finish,calls=0,closed=0;
 const render=component({open:true,name:'가상 일정',onClose:()=>{closed++},onConfirm:()=>{calls++;return new Promise(resolve=>{finish=resolve})}});
 const initial=render(),pending=confirmButton(initial).props.onClick();
 await confirmButton(initial).props.onClick();
 initial.props.onClose();
 assert.equal(calls,1);assert.equal(closed,0);
 assert.equal(confirmButton(render()).props.disabled,true);
 finish();await pending;
 assert.equal(closed,1);
});

test('delete failure remains visible and can be retried successfully without an unhandled rejection',async()=>{
 let calls=0,closed=0;
 const render=component({open:true,name:'가상 일정',onClose:()=>{closed++},onConfirm:async()=>{calls++;if(calls===1)throw Error('network interrupted')}});
 await confirmButton(render()).props.onClick();
 const failed=render();
 assert.equal(closed,0);
 assert.match(find(failed,node=>node.props?.role==='alert').props.children.join(''),/network interrupted/);
 assert.equal(confirmButton(failed).props.disabled,false);
 await confirmButton(failed).props.onClick();
 assert.equal(calls,2);assert.equal(closed,1);
});
