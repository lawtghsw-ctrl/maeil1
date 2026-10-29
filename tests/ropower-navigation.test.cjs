const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),ts=require('typescript');
function ast(file){return ts.createSourceFile(file,fs.readFileSync(file,'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)}
function execute(source,context){return vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText,context)}
function fn(tree,name){const node=tree.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);assert.ok(node,name);return node.getText(tree).replace(/^export\s+(?:default\s+)?/,'')}
function nodes(tree,visible=false){if(Array.isArray(tree))return tree.flatMap(child=>nodes(child,visible));if(!tree||typeof tree!=='object'||visible&&tree.props?.hidden)return [];return [tree,...nodes(tree.props?.children,visible)]}
function label(tree){if(Array.isArray(tree))return tree.map(label).join('');return tree&&typeof tree==='object'?label(tree.props?.children):tree==null?'':String(tree)}
const sidebar=ast('components/sidebar.tsx');
const protectedPaths=['/settlements','/changes','/analytics'];
const rbac={isAdminOnlyPath:pathname=>protectedPaths.some(path=>pathname===path||pathname.startsWith(path+'/')),normalizeRole:role=>String(role||'').toUpperCase()==='ADMIN'?'ADMIN':'STAFF'};
function nav(role='STAFF'){
 const cells=[];let cursor=0,tree;const context={
  React:{createElement:(type,props,...children)=>({type,props:{...props,children}})},
  useState(initial){const i=cursor++;if(!(i in cells))cells[i]=typeof initial==='function'?initial():initial;return [cells[i],v=>{cells[i]=typeof v==='function'?v(cells[i]):v}]},
  useId:()=> 'admin-menu',useEffect:()=>{},usePathname:()=> '/',useRouter:()=>({replace(){},refresh(){}}),
  useRole:()=>({name:'테스트 직원',roleLabel:role==='ADMIN'?'최종관리자':'직원',isAdmin:role==='ADMIN'}),
  Link:'Link',Brand:'Brand',ProfileBlock:'ProfileBlock',cn:(...parts)=>parts.filter(Boolean).join(' '),createClient:()=>({auth:{signOut(){}}}),
 };
 for(const item of sidebar.statements)if(ts.isImportDeclaration(item)&&item.moduleSpecifier.text==='lucide-react')for(const icon of item.importClause.namedBindings.elements)context[icon.name.text]='Icon';
 const declarations=sidebar.statements.filter(node=>ts.isVariableStatement(node)&&node.declarationList.declarations.some(n=>['menu','adminMenu'].includes(n.name.getText(sidebar)))).map(node=>node.getText(sidebar).replace(/^export\s+/,''));
 const api=execute([...declarations,fn(sidebar,'NavItems'),fn(sidebar,'Sidebar'),';({NavItems,Sidebar,menu,adminMenu})'].join('\n'),context);
 return {api,render(name='NavItems',props={pathname:'/',isAdmin:role==='ADMIN'}){cursor=0;tree=api[name](props);return tree},all:()=>nodes(tree),visible:()=>nodes(tree,true),button(text){const button=nodes(tree).find(n=>n.type==='button'&&label(n)===text);assert.ok(button,text);return button}};
}
test('staff navigation contains business pages and excludes app, call and device SMS routes',()=>{
 const u=nav();u.render();const links=u.visible().filter(n=>n.type==='Link');
 for(const href of ['/customers','/payments','/repayments','/leads'])assert.ok(links.some(n=>n.props.href===href),href);
 for(const href of [...protectedPaths,'/apps','/calls','/sms'])assert.equal(links.some(n=>n.props.href===href),false,href);
 assert.deepEqual(Array.from(u.api.adminMenu,item=>[item[0],item[1]]),[['정산','/settlements'],['기간별 변동내역','/changes'],['데이터 집계','/analytics']]);
 assert.equal(u.all().some(n=>n.type==='button'&&label(n)==='관리자 전용 메뉴'),false);
});
test('administrator menu starts collapsed, opens all three protected pages and preserves navigation',()=>{
 let navigated=0;const u=nav('ADMIN'),props={pathname:'/settlements',isAdmin:true,onNavigate:()=>navigated++};u.render('NavItems',props);
 assert.equal(u.button('관리자 전용 메뉴').props['aria-expanded'],false);
 u.button('관리자 전용 메뉴').props.onClick();u.render('NavItems',props);
 const links=u.visible().filter(n=>n.type==='Link'&&protectedPaths.includes(n.props.href));assert.deepEqual(links.map(n=>n.props.href),protectedPaths);assert.match(links[0].props.className,/bg-blue-50/);
 links[1].props.onClick();assert.equal(navigated,1);
 u.render('NavItems',{...props,isAdmin:false});assert.equal(u.all().some(n=>n.type==='Link'&&protectedPaths.includes(n.props.href)),false);
});
for(const role of ['ADMIN','STAFF'])test(`desktop and mobile menus use the server-provided ${role} role`,()=>{
 const u=nav(role);u.render('Sidebar');let menus=u.all().filter(n=>n.type===u.api.NavItems);assert.equal(menus.length,1);assert.equal(menus[0].props.isAdmin,role==='ADMIN');
 u.all().find(n=>n.type==='button'&&n.props['aria-label']==='메뉴 열기').props.onClick();u.render('Sidebar');menus=u.all().filter(n=>n.type===u.api.NavItems);assert.equal(menus.length,2);assert.ok(menus.every(n=>n.props.isAdmin===(role==='ADMIN')));
});
const section=ast('app/(admin)/[section]/layout.tsx');
function guard(options={}){
 const calls=[];const client={auth:{async getUser(){calls.push('auth');if(options.authThrows)throw Error('offline');return {data:{user:options.noUser?null:{id:'verified-user',user_metadata:{role:'ADMIN'}}},error:options.authError||null}}},from(table){assert.equal(table,'profiles');return {select(columns){assert.equal(columns,'role');return {eq(key,value){assert.equal(key,'id');assert.equal(value,'verified-user');return {async maybeSingle(){calls.push('profile');if(options.profileThrows)throw Error('offline');return {data:options.profile??null,error:options.profileError||null}}}}}}}}};
 const run=execute(fn(section,'SectionLayout')+';SectionLayout',{...rbac,createClient:async()=>client,redirect:location=>{throw Object.assign(Error('redirect'),{location})}});
 const child={content:'protected'};return {calls,child,run:section=>run({params:Promise.resolve({section}),children:child})};
}
test('ordinary sections do not perform a redundant administrator lookup',async()=>{const u=guard();for(const name of ['payments','customers','leads','repayments'])assert.equal(await u.run(name),u.child);assert.equal(u.calls.length,0)});
for(const name of ['settlements','changes','analytics']){
 test(`${name} accepts verified ADMIN database profiles`,async()=>{const u=guard({profile:{role:'ADMIN'}});assert.equal(await u.run(name),u.child);assert.deepEqual(u.calls,['auth','profile'])});
 for(const [why,options] of [['missing user',{noUser:true}],['auth error',{authError:{message:'expired'}}]])test(`${name} rejects ${why} before profile lookup`,async()=>{const u=guard(options);await assert.rejects(u.run(name),e=>e.location==='/login');assert.deepEqual(u.calls,['auth'])});
 for(const [why,options] of [['staff',{profile:{role:'STAFF'}}],['missing profile',{}],['empty role',{profile:{role:null}}],['profile error',{profile:{role:'ADMIN'},profileError:{message:'denied'}}]])test(`${name} rejects ${why} even with ADMIN user metadata`,async()=>{const u=guard(options);await assert.rejects(u.run(name),e=>e.location==='/')});
 for(const key of ['authThrows','profileThrows'])test(`${name} fails closed on ${key}`,async()=>{const u=guard({[key]:true});await assert.rejects(u.run(name),/offline/)});
}
