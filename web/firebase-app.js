(function(){
  'use strict';
  const cfg = window.FIREBASE_CONFIG || {};
  const validCfg = cfg.apiKey && !String(cfg.apiKey).startsWith('PASTE_') && cfg.projectId && cfg.projectId !== 'PROJECT_ID';
  const login = document.getElementById('firebaseLogin');
  const errorEl = document.getElementById('firebaseLoginError');
  const loadingEl = document.getElementById('firebaseLoginLoading');
  const form = document.getElementById('firebaseLoginForm');
  const btn = document.getElementById('firebaseLoginButton');
  document.body.classList.add('firebase-locked');

  if (!validCfg) {
    login.hidden = false;
    errorEl.textContent = 'Chưa cấu hình Firebase. Hãy điền firebase-config.js rồi deploy.';
    btn.disabled = true;
    loadingEl.textContent = 'Firebase config đang là placeholder.';
    return;
  }

  let app, auth, db, storage, currentUser = null, currentRole = 'user';
  const root = firebase.firestore.FieldPath.documentId();

  const errText = e => {
    const code = e && e.code || '';
    const map = {
      'auth/invalid-credential':'Email hoặc mật khẩu không đúng.',
      'auth/invalid-login-credentials':'Email hoặc mật khẩu không đúng.',
      'auth/user-disabled':'Tài khoản đã bị vô hiệu hóa.',
      'auth/too-many-requests':'Có quá nhiều lần thử. Hãy thử lại sau.',
      'auth/network-request-failed':'Lỗi mạng. Hãy kiểm tra kết nối.',
      'permission-denied':'Bạn không có quyền thực hiện thao tác này.'
    };
    return map[code] || e?.message || 'Đã xảy ra lỗi.';
  };
  const toast = msg => typeof showToast === 'function' ? showToast(msg) : console.log(msg);
  const deep = v => JSON.parse(JSON.stringify(v));
  const now = () => firebase.firestore.FieldValue.serverTimestamp();

  function flatTree(data){
    const courses=[], chapters=[], lessons=[], sessions=[];
    (data||[]).forEach((c,ci)=>{
      courses.push({...c, children:undefined, published: c.published !== false, order: Number.isFinite(c.order)?c.order:ci});
      (c.children||[]).forEach((ch,chi)=>{
        chapters.push({...ch, children:undefined, courseId:c.id, order:Number.isFinite(ch.order)?ch.order:chi});
        (ch.children||[]).forEach((l,li)=>{
          lessons.push({...l, children:undefined, courseId:c.id, chapterId:ch.id, order:Number.isFinite(l.order)?l.order:li});
          (l.children||[]).forEach((s,si)=>{
            const copy={...s, children:undefined, courseId:c.id, chapterId:ch.id, lessonId:l.id, order:Number.isFinite(s.order)?s.order:si};
            if (copy.url && /^(?:[a-zA-Z]:[\\/]|file:\/\/)/.test(copy.url)) { copy.legacyLocalUrl=copy.url; delete copy.url; }
            sessions.push(copy);
          });
        });
      });
    });
    return {courses,chapters,lessons,sessions};
  }
  async function writeTree(data){
    if(currentRole!=='admin') throw new Error('Chỉ admin mới được ghi nội dung.');
    const {courses,chapters,lessons,sessions}=flatTree(data);
    const batch=db.batch();
    const col=(name,id)=>db.collection(name).doc(id);
    courses.forEach(x=>batch.set(col('courses',x.id),{...x,published:x.published !== false,updatedAt:now(),createdAt:x.createdAt||now()},{merge:true}));
    chapters.forEach(x=>batch.set(db.collection('courses').doc(x.courseId).collection('chapters').doc(x.id),{...x,updatedAt:now(),createdAt:x.createdAt||now()},{merge:true}));
    lessons.forEach(x=>batch.set(db.collection('courses').doc(x.courseId).collection('chapters').doc(x.chapterId).collection('lessons').doc(x.id),{...x,updatedAt:now(),createdAt:x.createdAt||now()},{merge:true}));
    sessions.forEach(x=>batch.set(db.collection('courses').doc(x.courseId).collection('chapters').doc(x.chapterId).collection('lessons').doc(x.lessonId).collection('sessions').doc(x.id),{...x,updatedAt:now(),createdAt:x.createdAt||now()},{merge:true}));
    await batch.commit();
  }
  async function deleteTreeNode(node){
    if(currentRole!=='admin') return;
    const batch=db.batch();
    const {courses,chapters,lessons,sessions}=flatTree([node]);
    sessions.forEach(x=>batch.delete(db.collection('courses').doc(x.courseId).collection('chapters').doc(x.chapterId).collection('lessons').doc(x.lessonId).collection('sessions').doc(x.id)));
    lessons.forEach(x=>batch.delete(db.collection('courses').doc(x.courseId).collection('chapters').doc(x.chapterId).collection('lessons').doc(x.id)));
    chapters.forEach(x=>batch.delete(db.collection('courses').doc(x.courseId).collection('chapters').doc(x.id)));
    courses.forEach(x=>batch.delete(db.collection('courses').doc(x.id)));
    await batch.commit();
  }
  async function loadTree(){
    const snap=await db.collection('courses').where('published','==',true).get();
    const out=[];
    for(const cd of snap.docs){
      const c={id:cd.id,type:'course',...cd.data(),children:[]};
      const chSnap=await cd.ref.collection('chapters').orderBy('order').get();
      for(const chd of chSnap.docs){
        const ch={id:chd.id,type:'chapter',...chd.data(),children:[]};
        const lSnap=await chd.ref.collection('lessons').orderBy('order').get();
        for(const ld of lSnap.docs){
          const l={id:ld.id,type:'lesson',...ld.data(),children:[]};
          const sSnap=await ld.ref.collection('sessions').orderBy('order').get();
          sSnap.forEach(sd=>l.children.push({id:sd.id,type:'session',...sd.data()}));
          ch.children.push(l);
        }
        c.children.push(ch);
      }
      out.push(c);
    }
    out.sort((a,b)=>(a.order??0)-(b.order??0));
    return out;
  }
  async function loadAdminTree(){
    const snap=await db.collection('courses').get();
    const out=[];
    for(const cd of snap.docs){
      const c={id:cd.id,type:'course',...cd.data(),children:[]};
      const chSnap=await cd.ref.collection('chapters').orderBy('order').get();
      for(const chd of chSnap.docs){
        const ch={id:chd.id,type:'chapter',...chd.data(),children:[]};
        const lSnap=await chd.ref.collection('lessons').orderBy('order').get();
        for(const ld of lSnap.docs){
          const l={id:ld.id,type:'lesson',...ld.data(),children:[]};
          const sSnap=await ld.ref.collection('sessions').orderBy('order').get();
          sSnap.forEach(sd=>l.children.push({id:sd.id,type:'session',...sd.data()}));
          ch.children.push(l);
        }
        c.children.push(ch);
      }
      out.push(c);
    }
    out.sort((a,b)=>(a.order??0)-(b.order??0)); return out;
  }
  async function loadMaterials(courseId,chapterId,lessonId,sessionId){
    const ref=db.collection('courses').doc(courseId).collection('chapters').doc(chapterId).collection('lessons').doc(lessonId).collection('sessions').doc(sessionId).collection('materials');
    const snap=await ref.orderBy('order').get(); return snap.docs.map(d=>({id:d.id,...d.data()}));
  }

  // Firebase-backed source of truth overrides the old local persistence functions.
  const oldSaveCourseData = saveCourseData;
  const oldSaveProgress = saveProgress;
  saveCourseData = function(){
    oldSaveCourseData();
    if(currentRole==='admin') writeTree(COURSE_DATA).catch(e=>toast('Firebase: '+errText(e)));
  };
  saveProgress = function(){
    oldSaveProgress();
    if(!currentUser) return;
    const batch=db.batch();
    Object.entries(PROGRESS_DATA).forEach(([id,done])=>{
      const ref=db.collection('users').doc(currentUser.uid).collection('progress').doc(id);
      if(done) batch.set(ref,{completed:true,completedAt:now()},{merge:true});
      else batch.delete(ref);
    });
    batch.commit().catch(e=>toast('Không lưu được tiến độ: '+errText(e)));
  };

  async function loadRemoteProgress(){
    const snap=await db.collection('users').doc(currentUser.uid).collection('progress').get();
    const remote={}; snap.forEach(d=>{if(d.data().completed) remote[d.id]=true;});
    const local=PROGRESS_DATA||{}; const merged={...local,...remote};
    PROGRESS_DATA=merged; oldSaveProgress();
    const batch=db.batch(); Object.entries(merged).forEach(([id,v])=>{if(v) batch.set(db.collection('users').doc(currentUser.uid).collection('progress').doc(id),{completed:true,completedAt:now()},{merge:true});});
    await batch.commit();
  }

  function installAdminUI(){
    document.body.classList.toggle('is-admin',currentRole==='admin');
    const tools=document.getElementById('managementTools');
    if(tools) tools.classList.toggle('firebase-admin-tools',true);
    const email=document.getElementById('firebaseAccountEmail'); if(email) email.textContent=currentUser?.email||'';
    const manage=document.getElementById('management'); if(manage) manage.style.display=currentRole==='admin'?'':'none';
  }

  async function migrateLocal(){
    if(currentRole!=='admin') throw new Error('Chỉ admin mới được migration.');
    const tree=deep(COURSE_DATA); const flat=flatTree(tree);
    const counts={courses:flat.courses.length,chapters:flat.chapters.length,lessons:flat.lessons.length,sessions:flat.sessions.length};
    const ok=confirm(`Migration local → Firebase\\n\\n${counts.courses} khóa\\n${counts.chapters} chương\\n${counts.lessons} bài\\n${counts.sessions} session\\n\\nChạy lại sẽ không tạo duplicate vì giữ nguyên ID. Tiếp tục?`);
    if(!ok)return;
    await writeTree(tree); toast('Migration course data thành công.');
    await uploadLocalMaterialsNotice(tree);
  }
  async function uploadLocalMaterialsNotice(tree){
    const locals=[];
    flatTree(tree).sessions.forEach(s=>{if(s.legacyLocalUrl)locals.push(s);});
    if(locals.length) alert(`Có ${locals.length} tài liệu đang là đường dẫn local (C:\\, D:\\ hoặc file://).\\n\\nFirebase không thể tự đọc file từ máy bạn. Hãy dùng nút Upload tài liệu tại từng Session hoặc chọn file trực tiếp từ máy.`);
  }

  function injectAdminButtons(){
    const tools=document.getElementById('managementTools'); if(!tools || document.getElementById('firebaseMigrateBtn')) return;
    const b=document.createElement('button'); b.className='btn btn-secondary'; b.id='firebaseMigrateBtn'; b.textContent='☁ Migrate local → Firebase';
    b.onclick=()=>migrateLocal().catch(e=>alert(errText(e))); tools.appendChild(b);
    const note=document.createElement('span'); note.className='manage-status'; note.textContent='Firebase: online'; tools.appendChild(note);
  }

  async function addMaterial(session, file){
    if(currentRole!=='admin') throw new Error('Chỉ admin mới được upload.');
    const path=`courses/${session.courseId}/chapters/${session.chapterId}/lessons/${session.lessonId}/sessions/${session.id}/materials/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
    const task=storage.ref(path).put(file);
    await new Promise((resolve,reject)=>task.on('state_changed',snap=>{
      const pct=Math.round(snap.bytesTransferred/snap.totalBytes*100); const bar=document.querySelector(`[data-upload-for="${CSS.escape(session.id)}"] span`); if(bar)bar.style.width=pct+'%';
    },reject,resolve));
    const meta=await storage.ref(path).getMetadata();
    const url=await storage.ref(path).getDownloadURL();
    const mref=db.collection('courses').doc(session.courseId).collection('chapters').doc(session.chapterId).collection('lessons').doc(session.lessonId).collection('sessions').doc(session.id).collection('materials').doc();
    await mref.set({name:file.name,type:file.type||'application/octet-stream',size:file.size,storagePath:path,downloadUrl:url,createdAt:now(),updatedAt:now(),order:Date.now()});
    toast('✓ Upload thành công.'); return meta;
  }
  async function addExternal(session,url,name){
    if(currentRole!=='admin') throw new Error('Chỉ admin mới được thêm tài liệu.');
    let u; try{u=new URL(url)}catch{throw new Error('URL không hợp lệ.');}
    if(u.protocol!=='https:') throw new Error('Chỉ chấp nhận HTTPS.');
    const ref=db.collection('courses').doc(session.courseId).collection('chapters').doc(session.chapterId).collection('lessons').doc(session.lessonId).collection('sessions').doc(session.id).collection('materials').doc();
    await ref.set({name:name||u.hostname,type:'external',externalUrl:u.href,createdAt:now(),updatedAt:now(),order:Date.now()}); toast('Đã thêm link ngoài.');
  }

  async function replaceMaterial(session,m,file){
    if(currentRole!=='admin') throw new Error('Chỉ admin mới được thay file.');
    const path=`courses/${session.courseId}/chapters/${session.chapterId}/lessons/${session.lessonId}/sessions/${session.id}/materials/${Date.now()}_${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}`;
    await storage.ref(path).put(file);
    const url=await storage.ref(path).getDownloadURL();
    if(m.storagePath) await storage.ref(m.storagePath).delete().catch(()=>{});
    await db.collection('courses').doc(session.courseId).collection('chapters').doc(session.chapterId).collection('lessons').doc(session.lessonId).collection('sessions').doc(session.id).collection('materials').doc(m.id).set({name:file.name,type:file.type||'application/octet-stream',size:file.size,storagePath:path,downloadUrl:url,updatedAt:now()},{merge:true});
    toast('Đã thay file.');
  }
  async function deleteMaterial(session,m){
    if(currentRole!=='admin')return;
    if(!confirm(`Xóa tài liệu "${m.name||''}"?`))return;
    if(m.storagePath) await storage.ref(m.storagePath).delete().catch(e=>console.warn(e));
    await db.collection('courses').doc(session.courseId).collection('chapters').doc(session.chapterId).collection('lessons').doc(session.lessonId).collection('sessions').doc(session.id).collection('materials').doc(m.id).delete();
    toast('Đã xóa tài liệu.');
  }

  function materialUI(session){
    if(!session.courseId)return Promise.resolve('');
    return loadMaterials(session.courseId,session.chapterId,session.lessonId,session.id).then(ms=>{
      if(!ms.length && currentRole!=='admin') return '';
      const esc=typeof escapeHtml==='function'?escapeHtml:(x)=>String(x).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
      let html='<div class="firebase-materials">';
      ms.forEach(m=>{const href=m.externalUrl||m.downloadUrl||'#'; html+=`<div class="firebase-material"><span>📄</span><div class="firebase-material-meta"><div class="firebase-material-name">${esc(m.name||'Tài liệu')}</div><div class="firebase-material-size">${m.type==='external'?'Link ngoài':(m.size?Math.ceil(m.size/1024/1024*10)/10+' MB':'File')}</div></div><div class="firebase-material-actions"><a class="btn btn-secondary" style="min-height:26px;font-size:10px" href="${esc(href)}" target="_blank" rel="noopener">Mở</a>${currentRole==='admin'?`<button class="manage-action" data-firebase-replace-material="${esc(session.id)}" data-material-id="${esc(m.id)}">Thay</button><button class="manage-action danger" data-firebase-delete-material="${esc(session.id)}" data-material-id="${esc(m.id)}">Xóa</button>`:''}</div></div>`});
      if(currentRole==='admin') html+=`<div class="firebase-upload" data-upload-for="${esc(session.id)}"><label class="btn btn-secondary">＋ Thêm tài liệu<input type="file" multiple data-firebase-upload="${esc(session.id)}" accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip"></label><button class="btn btn-secondary" data-firebase-external="${esc(session.id)}" type="button">＋ URL ngoài</button><div class="firebase-progress"><span></span></div></div>`;
      return html+'</div>';
    });
  }

  // Enhance the existing session renderer after Firebase auth. Materials are appended without redesigning the page.
  const originalRenderSession=renderSession;
  renderSession=function(session,context){
    const node=originalRenderSession(session,context);
    if(currentUser){
      session.courseId=context.course?.id; session.chapterId=context.chapter?.id; session.lessonId=context.lesson?.id;
      materialUI(session).then(html=>{
        if(!html)return; const tmp=document.createElement('div'); tmp.innerHTML=html; node.appendChild(tmp.firstElementChild); bindMaterialActions(node,session);
      }).catch(e=>console.warn('material load',e));
    }
    return node;
  };
  function bindMaterialActions(node,session){
    node.querySelectorAll('[data-firebase-upload]').forEach(input=>input.addEventListener('change',async e=>{for(const f of e.target.files){try{await addMaterial(session,f)}catch(err){alert('Upload lỗi: '+errText(err));}} renderAll();}));
    node.querySelectorAll('[data-firebase-external]').forEach(b=>b.addEventListener('click',async()=>{const name=prompt('Tên tài liệu:');const url=prompt('HTTPS URL:');if(!url)return;try{await addExternal(session,url,name);renderAll()}catch(e){alert(errText(e))}}));
    node.querySelectorAll('[data-firebase-delete-material]').forEach(b=>b.addEventListener('click',async()=>{const ms=await loadMaterials(session.courseId,session.chapterId,session.lessonId,session.id);const m=ms.find(x=>x.id===b.dataset.materialId);if(m){await deleteMaterial(session,m);renderAll()}}));
    node.querySelectorAll('[data-firebase-replace-material]').forEach(b=>b.addEventListener('click',async()=>{const input=document.createElement('input');input.type='file';input.accept='.pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip';input.onchange=async()=>{const f=input.files?.[0];if(!f)return;const ms=await loadMaterials(session.courseId,session.chapterId,session.lessonId,session.id);const m=ms.find(x=>x.id===b.dataset.materialId);if(m){try{await replaceMaterial(session,m,f);renderAll()}catch(e){alert('Thay file lỗi: '+errText(e))}}};input.click()}));
  }

  async function exportFirebase(){
    const tree=currentRole==='admin'?await loadAdminTree():await loadTree();
    const mats=[];
    for(const c of tree)for(const ch of c.children||[])for(const l of ch.children||[])for(const s of l.children||[]){const ms=await loadMaterials(c.id,ch.id,l.id,s.id); mats.push(...ms.map(m=>({...m,courseId:c.id,chapterId:ch.id,lessonId:l.id,sessionId:s.id})))}
    const backup={version:4,source:'firebase',exportedAt:new Date().toISOString(),courseData:tree,materials:mats};
    const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(backup,null,2)],{type:'application/json'}));a.download='khoa-BON2026-firebase-backup.json';a.click();toast('Đã xuất Firebase backup.');
  }

  const originalImportBackup = importBackup;
  importBackup = async function(file){
    try{
      const text=await file.text(); const backup=JSON.parse(text);
      if(!validateImportedBackup(backup)) throw new Error('Cấu trúc backup không hợp lệ.');
      const c=backup.courseData||[]; const count=(type)=>{let n=0; const walk=x=>{(x||[]).forEach(v=>{if(v.type===type)n++;walk(v.children)});};walk(c);return n;};
      const msg=`Preview import\n\nCOURSES: ${count('course')}\nCHAPTERS: ${count('chapter')}\nLESSONS: ${count('lesson')}\nSESSIONS: ${count('session')}\nMATERIALS: ${Array.isArray(backup.materials)?backup.materials.length:0}\n\nImport sẽ cập nhật/ghi dữ liệu Firebase theo ID. Tiếp tục?`;
      if(!confirm(msg))return;
      COURSE_DATA=deep(backup.courseData); PROGRESS_DATA=deep(backup.progress||{});
      await writeTree(COURSE_DATA);
      if(Array.isArray(backup.materials)) for(const m of backup.materials){
        const ref=db.collection('courses').doc(m.courseId).collection('chapters').doc(m.chapterId).collection('lessons').doc(m.lessonId).collection('sessions').doc(m.sessionId).collection('materials').doc(m.id);
        const data={...m}; delete data.id; delete data.courseId; delete data.chapterId; delete data.lessonId; delete data.sessionId; await ref.set(data,{merge:true});
      }
      saveProgress(); state.openIds.clear(); renderAll(); toast('Đã import Firebase backup.');
    }catch(e){alert('Không thể import: '+errText(e))}
  };

  async function init(){
    try{
      app=firebase.initializeApp(cfg); auth=firebase.auth(); db=firebase.firestore(); storage=firebase.storage();
      form.addEventListener('submit',async e=>{e.preventDefault();errorEl.textContent='';btn.disabled=true;loadingEl.textContent='Đang đăng nhập...';try{await auth.signInWithEmailAndPassword(document.getElementById('firebaseEmail').value.trim(),document.getElementById('firebasePassword').value)}catch(err){errorEl.textContent=errText(err)}finally{btn.disabled=false;loadingEl.textContent=''}});
      document.getElementById('firebaseLogoutBtn')?.addEventListener('click',()=>auth.signOut());
      auth.onAuthStateChanged(async user=>{
        currentUser=user;
        if(!user){document.body.classList.add('firebase-locked');login.hidden=false;return;}
        login.hidden=true; loadingEl.textContent='Đang tải dữ liệu...';
        try{
          const userRef=db.collection('users').doc(user.uid); const us=await userRef.get();
          if(!us.exists){await userRef.set({email:user.email||'',displayName:user.displayName||'',role:'user',createdAt:now()},{merge:true});currentRole='user';}
          else currentRole=us.data().role==='admin'?'admin':'user';
          const tree=currentRole==='admin'?await loadAdminTree():await loadTree();
          COURSE_DATA=tree.length?tree:deep(DEFAULT_COURSE_DATA);
          await loadRemoteProgress();
          document.body.classList.remove('firebase-locked'); installAdminUI(); injectAdminButtons();
          const chip=document.querySelector('.hero-foot .stat-chip:nth-child(3)'); if(chip)chip.textContent='Nội dung + tiến độ lưu trên Firebase';
          renderAll();
        }catch(err){document.body.classList.add('firebase-locked');login.hidden=false;errorEl.textContent=errText(err);loadingEl.textContent='Không thể tải dữ liệu.';console.error(err)}
      });
    }catch(e){login.hidden=false;errorEl.textContent='Firebase init fail: '+errText(e)}
  }
  init();
})();
