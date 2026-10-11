const $=s=>document.querySelector(s), question=$('#question'), KB=BANK_KNOWLEDGE;
const samples={answer:KB.cases[0].question,clarify:'Не помню пароль интернет-банка. Что делать?',insufficient:'Можно сейчас открыть счёт по акции РКО «Экспресс»?'};
const initial=()=>({stage:'empty',question:'',clarification:'',caseId:null,sourceId:null,draft:'',editing:false,edited:false,sourceVerified:false,copied:false,manual:false,reason:'',route:'',missing:[]});
const state=initial();let audience='retail',revision=0,toastTimer,openedSource=null,copyPending=false,copyOperation=null;
const esc=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
const norm=s=>s.toLowerCase().replace(/ё/g,'е');
const isBusiness=q=>/бизнес|(?:^|[^а-яa-z0-9])ип(?=$|[^а-яa-z0-9])|ооо|юрлиц|юридическ|организац/.test(q);
const isRetail=q=>/частн|физическ|физлиц|приобанк/.test(q);
const isNewVersion=q=>/нов(?:ая|ой|ую|ый|ого|ом)\s+(?:верси|интернет[ -]?банк|дбо)/.test(q);
const hasTariffQuestion=q=>/комисси|тариф|процент|ставк|стоимост|сколько стоит|бесплатн/.test(q);
function limitInput(field,max){if(field.value.length<=max)return field.value;const start=field.selectionStart,end=field.selectionEnd,direction=field.selectionDirection;field.value=field.value.slice(0,max);if(typeof field.setSelectionRange==='function'&&Number.isInteger(start)&&Number.isInteger(end))field.setSelectionRange(Math.min(start,max),Math.min(end,max),direction||'none');return field.value;}
const retailAccess={id:'retail-access',topic:'Частные клиенты · помощь со входом',source:'contacts',answer:'Для помощи со входом в Приобанк Онлайн обратитесь в техническую поддержку: +7 (4912) 50-44-50 или 8-800-600-96-97. Специалист уточнит ситуацию и порядок восстановления доступа.'};
const businessSecurity={id:'business-security',topic:'Бизнес и ИП · защита доступа',source:'business',answer:'При утрате телефона или токена либо раскрытии данных доступа как можно быстрее обратитесь в отделение или техническую поддержку банка для блокировки доступа.'};
const getCase=id=>id==='retail-access'?retailAccess:id==='business-security'?businessSecurity:KB.cases.find(c=>c.id===id);
function notify(t){$('#toast').textContent=t;$('#toast').classList.add('toast-visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').classList.remove('toast-visible'),2800);}
function steps(current){document.querySelectorAll('[data-step]').forEach(el=>{const n=+el.dataset.step;el.classList.toggle('done',n<current);el.classList.toggle('current',n===current);if(n===current)el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');});}
function count(){$('#char-count').textContent=question.value.length+' / 1200';}
function selectScenario(name){document.querySelectorAll('[data-scenario]').forEach(el=>{const on=el.dataset.scenario===name;el.classList.toggle('active',on);el.setAttribute('aria-pressed',String(on));});}
function resetState(){revision++;clearTimeout(toastTimer);$('#toast').classList.remove('toast-visible');$('#toast').textContent='';Object.assign(state,initial());$('#question-error').textContent='';question.removeAttribute('aria-invalid');$('#source-dialog').close();openedSource=null;}
function examples(){document.querySelectorAll('[data-audience]').forEach(el=>{const on=el.dataset.audience===audience;el.classList.toggle('active',on);el.setAttribute('aria-pressed',String(on));});$('#example-list').innerHTML=KB.cases.filter(c=>c.audience===audience).map(c=>`<button class="example-button" data-example="${c.id}">${esc(c.label)}</button>`).join('');document.querySelectorAll('[data-example]').forEach(el=>el.addEventListener('click',()=>{resetState();const c=getCase(el.dataset.example);question.value=c.question;count();setAnswer(c.id);state.question=c.question;selectScenario('answer');render();}));}
function setAnswer(id){const c=getCase(id);state.stage='answer';state.caseId=id;state.sourceId=c.source;state.draft=c.answer;state.sourceVerified=false;state.copied=false;state.manual=false;}
function insufficient(sourceId,reason,route,missing=[]){Object.assign(state,{stage:'insufficient',sourceId,reason,route,missing});selectScenario('insufficient');}
function classify(q){
  const exact=KB.cases.find(c=>norm(c.question)===q);if(exact){setAnswer(exact.id);return;}
  const business=isBusiness(q);
  if(/мошен|подозрительн/.test(q)||(/звонят|позвонили|входящ|просят/.test(q)&&/код|sms|смс|парол|логин|данные|карт/.test(q))){setAnswer('fraud');return;}
  if(business&&/потер|утер|украл|пропал|раскрыт|скомпромет/.test(q)&&/телефон|токен|устройств|парол|доступ/.test(q)){setAnswer('business-security');return;}
  if(/карт/.test(q)&&/потер|утер|украл|пропал/.test(q)){setAnswer('lost');if(hasTariffQuestion(q))state.draft+=' Стоимость перевыпуска нужно уточнить по действующему тарифу банка; в прототипе она не подтверждена.';return;}
  const qrTopic=/qr|кьюар|сбп|приоqr/.test(q),acceptsQR=/прием|приним|продаж/.test(q),merchantQR=acceptsQR||business&&/подключ/.test(q);
  if(qrTopic&&(/парол|логин|войти|вход|доступ/.test(q)||(!acceptsQR&&/оплатить|платить|оплач|перевести|перевод|покуп/.test(q)))){insufficient(null,'Подготовленный материал ПриоQR описывает приём платежей бизнесом. Он не подтверждает порядок оплаты, перевода или восстановления доступа.','Специалист по теме обращения',['Что нужно: приём платежей, оплата, перевод или помощь со входом','Тип клиента и название сервиса','Подтверждающий материал']);return;}
  if(/парол|логин|войти|вход|доступ/.test(q)&&/интернет|онлайн|приобанк|дбо/.test(q)){
    if(business&&isNewVersion(q))insufficient('business','Публичный FAQ не подтверждает порядок восстановления для новой версии Интернет-Банка.','Техническая поддержка ДБО',['Версия сервиса','Что произошло со входом','Подтверждённая инструкция для этой версии']);
    else if(business)setAnswer('business-access');
    else if(isRetail(q))setAnswer('retail-access');
    else{state.stage='clarify';selectScenario('clarify');}return;
  }
  if(/экспресс/.test(q)){insufficient('rko','На странице указан период открытия по предложению «Экспресс»: 10.03–30.09.2026. На дату исследования он закончился. Подтверждения продления в изученных материалах нет.','Специалист по РКО',['Город / офис','Тип клиента: ИП или организация','Дата предполагаемого открытия','Действующие условия или подтверждение продления']);return;}
  if(hasTariffQuestion(q)){
    const src=/эквайр/.test(q)?'acquiring':/qr|кьюар|сбп/.test(q)&&/прием|приним|оплат/.test(q)?'qr':/рко|расчетн/.test(q)?'rko':/светофор|контрагент/.test(q)?'traffic':null;
    insufficient(src,'В прототипе нет проверенного действующего тарифного документа для этих условий. Публичная страница продукта не подтверждает точную сумму для конкретного клиента.',src?'Специалист по продукту':'Специалист по тарифам',['Продукт и вид операции','Тип клиента','Город / офис, если применимо','Действующий тариф с датой']);return;
  }
  let id=null;
  if((/код|sms|смс/.test(q)&&/звон|просят|мошен/.test(q))||/подозрительн|мошенник/.test(q))id='fraud';
  else if(/разблок/.test(q)&&/карт/.test(q))id='unblock';
  else if(/блок/.test(q)&&/карт/.test(q))id=/прилож|приобанк|мобиль/.test(q)?'block':'lost';
  else if(/скач|установ/.test(q)&&/прилож|приобанк/.test(q))id='download';
  else if(/регистра|подключ/.test(q)&&/приобанк|онлайн/.test(q)&&!business)id='registration';
  else if(/эквайр/.test(q))id='acquiring';
  else if(qrTopic&&merchantQR&&!/частн|физическ|физлиц/.test(q))id='qr';
  else if(/зарплат|реестр|1с/.test(q))id='payroll';
  else if(/контрагент|светофор/.test(q))id='traffic';
  else if(/рко|расчетн.*счет|счет.*ип|счет.*ооо/.test(q)&&/откры|подключ|документ/.test(q))id='rko';
  else if(/банкомат|отделен|офис/.test(q))id='office';
  else if(/обращен|жалоб|претензи/.test(q))id='appeal';
  if(id)setAnswer(id);else insufficient(null,'Для этого вопроса среди подготовленных сценариев нет достаточного подтверждения. Нужен документ банка или помощь специалиста.','Специалист по теме обращения',['Тема и продукт','Что хочет узнать клиент','Подтверждающий материал']);
}
function prepare(text){if(typeof text!=='string'||!text.trim()||text.length>1200)throw Error('Введите вопрос длиной от 1 до 1200 символов.');resetState();state.question=text.trim();question.value=state.question;count();classify(norm(state.question));if(state.stage==='answer')selectScenario('answer');render();$('#result-heading').focus({preventScroll:true});}
function clarify(channel,detail=''){
  if(state.stage!=='clarify')throw Error('Сейчас нет вопроса для уточнения.');if(!['retail','business','custom'].includes(channel))throw Error('Выберите тип клиента.');if(typeof detail!=='string'||detail.length>500)throw Error('Уточнение должно содержать до 500 символов.');
  if(channel==='custom'){if(!detail.trim())throw Error('Введите уточнение.');const q=norm(detail);channel=isBusiness(q)?'business':isRetail(q)?'retail':'custom';}
  state.clarification=detail.trim()||(channel==='retail'?'Частный клиент · Приобанк Онлайн':'Бизнес или ИП · Интернет-Банк');
  if(channel==='custom')insufficient(null,'Не удалось определить сервис по уточнению. Нужны тип клиента и название интернет-банка.','Техническая поддержка ДБО',['Частный клиент или бизнес','Название и версия сервиса']);
  else{classify(norm(`${state.question}\n${state.clarification}\n${channel==='retail'?'Частный клиент':'Бизнес или ИП'}`));if(state.stage==='answer')selectScenario('answer');}render();
}
function history(){return state.clarification?`<div class="clarification-history"><strong>Уточнение:</strong> ${esc(state.clarification)}</div>`:'';}
function sourceCard(id,unsupported=false){const d=KB.sources[id];return `<button class="source-card" data-source="${id}"><span class="document-icon" aria-hidden="true">≡</span><span><strong>${esc(d.title)}</strong><small>${esc(d.section)}</small></span><span class="source-action">${unsupported?'Проверить ограничение':'Открыть источник'}</span></button>`;}
function render(){let html='',status='Ожидает вопроса',statusClass='';
  if(state.stage==='empty'){steps(1);html='<div class="empty-state"><span class="empty-icon" aria-hidden="true">≡</span><h3>Разберите обращение клиента</h3><p>Введите вопрос или выберите пример по продукту. Черновик появится вместе с официальным источником.</p><span class="empty-hint">14 подготовленных обращений · частные клиенты, бизнес и ИП</span></div>';}
  else if(state.stage==='clarify'){status='Нужно уточнение';statusClass='warning';steps(2);html='<div class="result-body"><div class="notice blue"><h3>Каким сервисом пользуется клиент?</h3><p>У частных клиентов — Приобанк Онлайн. У бизнеса и ИП — Интернет-Банк. Инструкции по доступу отличаются.</p></div><p class="small-label">Уточните у клиента</p><div class="clarification-options"><button class="secondary" data-channel="retail">Частный клиент</button><button class="secondary" data-channel="business">Бизнес или ИП</button></div><form id="clarification-form" class="clarification-form"><label for="clarification" class="sr-only">Своё уточнение</label><input id="clarification" maxlength="500" placeholder="Или уточните тип клиента и сервис"><button class="primary" type="submit">Уточнить</button></form><p id="clarification-error" class="error" aria-live="polite"></p></div>';}
  else if(state.stage==='insufficient'){status='Информации недостаточно';statusClass='warning';steps(2);html=`<div class="result-body">${history()}<div class="notice"><h3>Условия пока нельзя подтвердить</h3><p>${esc(state.reason)}</p></div><div class="routing"><span class="small-label">Рекомендуемое направление</span><strong>${esc(state.route)}</strong><p>Это предложение для оператора; внутренняя очередь банка не подключена.</p></div><div class="missing"><p class="small-label">Что нужно для продолжения</p><ul>${state.missing.map(v=>`<li>${esc(v)}</li>`).join('')}</ul></div><div class="insufficient-actions"><button id="manual" class="primary">Подготовить запрос специалисту</button><button id="change-question" class="secondary">Изменить вопрос</button></div>${state.sourceId?`<div class="sources-heading"><span>Найденный материал</span><span class="material-warning">Не подтверждает условия</span></div>${sourceCard(state.sourceId,true)}`:''}</div>`;}
  else{const c=getCase(state.caseId);status=state.copied?'Скопировано':state.manual?'Запрос специалисту':'Черновик готов';statusClass=state.manual?'warning':'ready';steps(state.copied?5:state.sourceVerified||state.editing?4:2);
    html=`<div class="result-body"><div class="result-kicker"><span>${esc(state.manual?state.route:c.topic)}</span><span>Проверено ${KB.checked}</span></div>${history()}<div class="review-note ${state.manual?'manual-copy':''}"><span aria-hidden="true">${state.manual?'!':'ⓘ'}</span><span>${state.manual?'Запрос на проверку. Подтверждённых условий в нём нет.':'Черновик по публичным материалам — проверьте перед консультацией'}</span></div><label class="answer-label" for="draft">${state.manual?'Текст запроса':'Текст ответа'}</label><textarea id="draft" maxlength="5000" ${state.editing?'':'readonly'} aria-describedby="draft-meta"></textarea><div class="editor-meta" id="draft-meta"><span id="edit-state">${state.edited?'Текст изменён оператором':state.editing?'Можно изменить формулировку':'Доступна правка оператором'}</span><span>${state.manual?'Ручной текст':'Публичный источник'}</span></div>${state.manual?'':`<div class="sources-heading"><span>Основание ответа</span><span id="source-verified" class="${state.sourceVerified?'verified':''}">${state.sourceVerified?'Проверен оператором':state.edited?'Проверьте ответ после правки':'Требует проверки'}</span></div>${sourceCard(state.sourceId)}${c.linkLabel?`<a class="resource-link" target="_blank" rel="noopener noreferrer" href="${esc(KB.sources[state.sourceId].url)}">${esc(c.linkLabel)}</a>`:''}`}<div class="result-actions"><button id="edit" class="secondary">${state.editing?'Завершить правку':'Редактировать'}</button><button id="copy" class="primary">${state.manual?'Скопировать запрос':'Скопировать ответ'}</button><p id="copy-note" class="copy-note ${state.copied?'success':''}">${state.copied?'Скопирован текущий текст, включая ваши изменения.':state.sourceVerified||state.manual?'Копируется только текст из поля выше. Отправку выполняет оператор.':'Откройте источник и отметьте, что проверили ответ.'}</p></div></div>`;
  }
  $('#result-status').textContent=status;$('#result-status').className='status '+statusClass;$('#result').innerHTML=html;$('#result-heading').setAttribute('tabindex','-1');document.querySelectorAll('[data-example]').forEach(el=>el.classList.toggle('selected',el.dataset.example===state.caseId));
  if($('#draft')){$('#draft').value=state.draft;$('#copy').disabled=copyPending||!state.draft.trim()||(!state.sourceVerified&&!state.manual);$('#draft').addEventListener('input',e=>updateDraft(limitInput(e.target,5000),false));}
  $('#clarification')?.addEventListener('input',e=>limitInput(e.target,500));
  document.querySelectorAll('[data-source]').forEach(el=>el.addEventListener('click',()=>openSource(el.dataset.source)));
  $('#edit')?.addEventListener('click',()=>{state.editing=!state.editing;state.copied=false;render();if(state.editing)$('#draft').focus();});$('#copy')?.addEventListener('click',copy);$('#manual')?.addEventListener('click',manual);$('#change-question')?.addEventListener('click',()=>{resetState();selectScenario(null);render();question.focus();});document.querySelectorAll('[data-channel]').forEach(el=>el.addEventListener('click',()=>clarify(el.dataset.channel)));$('#clarification-form')?.addEventListener('submit',e=>{e.preventDefault();try{clarify('custom',$('#clarification').value);}catch(err){$('#clarification-error').textContent=err.message;}});
}
function updateDraft(text,redraw=true){revision++;state.draft=text;state.edited=true;state.sourceVerified=false;state.copied=false;state.editing=true;if(redraw){render();return;}$('#edit-state').textContent='Текст изменён оператором';$('#source-verified')?.classList.remove('verified');if($('#source-verified'))$('#source-verified').textContent='Проверьте ответ после правки';$('#copy').disabled=copyPending||!text.trim()||!state.manual;$('#copy-note').textContent=state.manual?'Копируется только текст из поля выше.':'После правки повторно проверьте ответ по источнику.';$('#copy-note').className='copy-note';$('#result-status').textContent=state.manual?'Запрос специалисту':'Черновик готов';steps(4);}
function openSource(id=state.sourceId){const d=KB.sources[id];if(!d)throw Error('Для этого обращения источник не найден.');openedSource=id;const canConfirm=state.stage==='answer'&&!state.manual&&id===state.sourceId;
  $('#source-content').innerHTML=`<h2 id="source-title">${esc(d.title)}</h2><div class="source-metadata"><span>${esc(d.kind)}</span><span>Проверено ${KB.checked}</span><span>${canConfirm?'Основание черновика':'Ограничение подтверждения'}</span></div><h3 class="source-section">${esc(d.section)}</h3><p class="summary-label">Краткое содержание · пересказ</p><div class="source-excerpt">${esc(d.summary)}</div><p class="source-footnote">${esc(d.caveat)}</p><a class="resource-link" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">Открыть оригинал на сайте банка</a><p class="source-footnote">Дата проверки — дата исследования, а не дата действия документа. Перед консультацией сравните сведения с оригиналом.</p>`;
  $('#verify-source').hidden=!canConfirm;$('#return-to-draft').textContent=canConfirm?'Вернуться к черновику':'Вернуться к обращению';$('#source-dialog').showModal();if(canConfirm)steps(3);return{title:d.title,url:d.url,canConfirm};
}
function verify(){if(state.stage!=='answer'||state.manual||!$('#source-dialog').open||openedSource!==state.sourceId)throw Error('Откройте источник текущего ответа.');state.sourceVerified=true;$('#source-dialog').close();render();notify('Ответ отмечен как проверенный по источнику');}
function manual(){if(state.stage!=='insufficient')throw Error('Запрос доступен после сообщения о недостатке информации.');state.stage='answer';state.manual=true;state.editing=true;state.draft=`Направление: ${state.route}.\nОбращение: «${state.question}».${state.clarification?'\nУточнение: '+state.clarification+'.':''}\nПричина передачи: ${state.reason}\nНужно уточнить: ${state.missing.join('; ')}.\nПросьба предоставить действующий документ и подтвердить применимые условия.`;render();$('#draft').focus();}
async function copy(){
  if(copyPending)return{copied:false,pending:true};
  if(state.stage!=='answer'||!state.draft.trim()||(!state.sourceVerified&&!state.manual))throw Error('Подготовьте текст и проверьте источник.');
  const text=state.draft,version=revision,operation={};let timeout,nativeWrite=null;copyPending=true;copyOperation=operation;$('#copy').disabled=true;
  const release=()=>{if(copyOperation!==operation)return;copyOperation=null;copyPending=false;if($('#copy'))$('#copy').disabled=!state.draft.trim()||(!state.sourceVerified&&!state.manual);};
  try{
    if(!navigator.clipboard?.writeText)throw Error('Unavailable');
    nativeWrite=Promise.resolve(navigator.clipboard.writeText(text));
    // A UI timeout cannot cancel a native write. Keep the lock until it settles.
    nativeWrite.then(release,release);
    await Promise.race([nativeWrite,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('Timeout')),1600);})]);
    if(version!==revision)return{copied:false,stale:true};
    state.copied=true;state.editing=false;render();notify(state.manual?'Запрос скопирован':'Ответ скопирован');return{copied:true,text};
  }catch(err){
    if(version!==revision)return{copied:false,stale:true};
    $('#draft').focus();$('#draft').select();$('#copy-note').textContent='Буфер обмена недоступен. Текст выделен: нажмите Ctrl+C или ⌘C.'+(err.message==='Timeout'?' Автоматическая запись ещё ожидается; повторное копирование станет доступно после её завершения.':'');$('#copy-note').className='copy-note';return{copied:false,manualSelection:true,pending:copyPending&&Boolean(nativeWrite)};
  }finally{clearTimeout(timeout);if(!nativeWrite)release();}
}
$('#question-form').addEventListener('submit',e=>{e.preventDefault();try{prepare(question.value);}catch(err){$('#question-error').textContent=err.message;question.setAttribute('aria-invalid','true');question.focus();}});
question.addEventListener('input',()=>{limitInput(question,1200);count();if(state.stage!=='empty'&&question.value.trim()!==state.question){resetState();selectScenario(null);render();}$('#question-error').textContent='';question.removeAttribute('aria-invalid');});
document.querySelectorAll('[data-scenario]').forEach(el=>el.addEventListener('click',()=>{resetState();selectScenario(el.dataset.scenario);question.value=samples[el.dataset.scenario];count();render();question.focus();}));
document.querySelectorAll('[data-audience]').forEach(el=>el.addEventListener('click',()=>{audience=el.dataset.audience;examples();}));
$('#reset').addEventListener('click',()=>{resetState();selectScenario(null);question.value='';count();render();question.focus();});$('#verify-source').addEventListener('click',verify);$('#close-source').addEventListener('click',()=>$('#source-dialog').close());$('#return-to-draft').addEventListener('click',()=>$('#source-dialog').close());$('#source-dialog').addEventListener('close',()=>steps(state.stage==='answer'?(state.copied?5:state.sourceVerified||state.editing?4:2):state.stage==='empty'?1:2));
for(const id of ['source-dialog','materials-dialog']){
  const dialog=$('#'+id);
  dialog.addEventListener('click',e=>{const r=e.currentTarget.getBoundingClientRect();if(e.target===e.currentTarget&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom))e.currentTarget.close();});
  dialog.addEventListener('keydown',e=>{
    if(e.key!=='Tab'||!dialog.open)return;
    const controls=Array.from(dialog.querySelectorAll('button, a[href], input, select, textarea, [tabindex]')).filter(el=>!el.disabled&&!el.hidden&&el.tabIndex>=0&&el.getClientRects().length);
    const first=controls[0],last=controls[controls.length-1];if(!first)return;
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  });
}
$('#materials').addEventListener('click',()=>{$('#materials-list').innerHTML=Object.values(KB.sources).map(d=>`<article class="material-item"><h3>${esc(d.title)}</h3><p>${esc(d.summary)}</p><p class="source-footnote">${esc(d.caveat)}</p><a class="resource-link" href="${esc(d.url)}" target="_blank" rel="noopener noreferrer">Официальный источник</a></article>`).join('');$('#materials-dialog').showModal();});$('#close-materials').addEventListener('click',()=>$('#materials-dialog').close());count();examples();render();
// Structured browser actions use the same visible state and safeguards.
if(document.modelContext?.registerTool){const lifecycle=new AbortController(),schema=p=>({type:'object',properties:p,additionalProperties:false}),register=(name,description,inputSchema,execute,readOnlyHint=false)=>{try{Promise.resolve(document.modelContext.registerTool({name,description,inputSchema,annotations:{readOnlyHint,untrustedContentHint:readOnlyHint},execute},{signal:lifecycle.signal})).catch(()=>{});}catch{}};
register('get_operator_state','Read the current prototype result and source-check state.',schema({}),()=>({...state}),true);
register('prepare_operator_draft','Prepare a source-backed preset or show missing evidence. Does not contact the bank.',{...schema({question:{type:'string',minLength:1,maxLength:1200}}),required:['question']},v=>{prepare(v.question);return{stage:state.stage,draft:state.draft};});
register('answer_operator_clarification','Specify private customer or business and update the visible result.',{...schema({channel:{type:'string',enum:['retail','business','custom']},detail:{type:'string',maxLength:500}}),required:['channel']},v=>{clarify(v.channel,v.detail||'');return{stage:state.stage,draft:state.draft};});
register('open_operator_source','Open the supporting public-source summary and its official link.',schema({}),()=>openSource());
register('verify_operator_source','Mark the currently displayed draft as checked against its source.',schema({}),()=>{verify();return{sourceVerified:true};});
register('edit_operator_draft','Edit the visible text and clear its previous verification.',{...schema({text:{type:'string',minLength:1,maxLength:5000}}),required:['text']},v=>{if(state.stage!=='answer'||typeof v.text!=='string'||!v.text.trim()||v.text.length>5000)throw Error('Нужен черновик и текст до 5000 символов.');updateDraft(v.text);return{draft:state.draft,sourceVerified:false};});
register('copy_operator_draft','Copy only the current reviewed text; no message is sent.',schema({}),()=>copy());window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});}
