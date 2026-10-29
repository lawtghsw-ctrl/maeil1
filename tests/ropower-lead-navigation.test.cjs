const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),ts=require('typescript'),vm=require('node:vm');
const React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
const file='app/(admin)/[section]/page.tsx';
const ast=ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const component=ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='DbManagement');
assert.ok(component);
test('DB management renders only the Ropower lead list, including old external-tab links',()=>{
 for(const query of ['', 'tab=external','tab=dowon']){
  const render=vm.runInNewContext(ts.transpileModule(component.getText(ast)+';DbManagement',{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText,{
   exports:{},require,useSearchParams:()=>new URLSearchParams(query),PageHeader:props=>React.createElement('h1',null,props.description),MetaLeadsV28:()=>React.createElement('p',null,'ROPOWER_LIST'),ExternalLeads:()=>{throw Error('Other-company panel must not render')},
  });
  const html=renderToStaticMarkup(React.createElement(render));assert.match(html,/로파워/);assert.match(html,/ROPOWER_LIST/);assert.doesNotMatch(html,/타 DB|도원DB|EXTERNAL_LIST/);
 }
});
