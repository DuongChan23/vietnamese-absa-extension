const review=document.querySelector('#review');
const status=document.querySelector('#status');
const results=document.querySelector('#results');
const analyze=document.querySelector('#analyze');
const fromPage=document.querySelector('#fromPage');

// Source IDs must come from the NB20 model_config.json, not guessed labels.
async function loadSources(){
 try{
  const resp=await fetch('http://127.0.0.1:8000/health');
  const data=await resp.json();
  if(!data.ready){status.textContent='Backend chưa nạp mô hình: '+(data.error||'unknown');return;}
  status.textContent='Backend đã sẵn sàng.';
 }catch(_){status.textContent='Không kết nối được API tại 127.0.0.1:8000.';}
}
fromPage.addEventListener('click',async()=>{
 try{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  if(!tab?.id)throw new Error('Không tìm thấy tab.');
  const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>window.getSelection()?.toString()||''});
  if(!result.trim())throw new Error('Hãy bôi đen nội dung đánh giá trên trang trước.');
  review.value=result.trim().slice(0,3000);
  status.textContent='Đã lấy đoạn văn được chọn.';
 }catch(err){status.textContent='Không lấy được văn bản: '+err.message;}
});
analyze.addEventListener('click',async()=>{
 const text=review.value.trim();if(!text){status.textContent='Nhập hoặc chọn một đánh giá trước.';return;}
 analyze.disabled=true;status.textContent='Đang phân tích...';results.replaceChildren();
 try{
  const response=await fetch('http://127.0.0.1:8000/predict',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text,source:"unified"})});
  const data=await response.json();
  if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:JSON.stringify(data.detail));
  const aspects=data.aspects||[];status.textContent=`Tìm thấy ${aspects.length} aspect.`;
  for(const a of aspects){
   const item=document.createElement('div');item.className='item '+a.sentiment;
   const title=document.createElement('strong');title.textContent=a.aspect;
   const desc=document.createElement('div');desc.className='meta';desc.textContent=`${a.category} · ${a.sentiment} · ký tự ${a.start}-${a.end}${a.sources ? " · nguồn nhãn: " + a.sources.join(", ") : ""}`;
   item.append(title,desc);results.append(item);
  }
 }catch(err){status.textContent='Lỗi: '+err.message;}finally{analyze.disabled=false;}
});
loadSources();
