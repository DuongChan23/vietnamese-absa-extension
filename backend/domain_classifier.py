"""Conservative hybrid product-domain detection for Shopee metadata."""
from __future__ import annotations
import json
import os
import re
import unicodedata
from pathlib import Path
from threading import Lock
from typing import Any

VICLOABSA="vicloabsa"
VISD4SA="visd4sa"
ALLOWED_SOURCES={VICLOABSA,VISD4SA}
AUTO_THRESHOLD=0.90
CONFIRM_THRESHOLD=0.65

CATEGORY_TERMS={
 VICLOABSA:{"thoi trang","thoi trang nam","thoi trang nu","thoi trang tre em","quan ao","ao","ao thun","ao so mi","ao khoac","quan","quan jeans","quan short","dam","vay","do bo","do lot","giay dep","giay the thao","tui xach","phu kien thoi trang"},
 VISD4SA:{"dien thoai","smartphone","dien tu","thiet bi dien tu","phu kien dien thoai","may tinh","laptop","may tinh bang","tablet","tai nghe","loa","camera","tivi","smart tv","dong ho thong minh","sac du phong","phu kien may tinh"},
}
# Populate only with category IDs verified from live Shopee metadata.
CATEGORY_ID_TO_SOURCE:dict[str,str]={}
STRONG_NAME_TERMS={
 VICLOABSA:{"ao thun","ao so mi","ao khoac","quan jeans","quan short","quan tay","quan au","quan ao","hoodie","sweatshirt","dam","vay","giay sneaker","giay the thao","do bo","do lot"},
 VISD4SA:{"iphone","samsung galaxy","xiaomi redmi","oppo find","dien thoai","smartphone","may tinh bang","laptop","tai nghe","airpods","camera","tivi","smart tv","loa bluetooth","sac du phong","dong ho thong minh"},
}
DESCRIPTION_TERMS={
 VICLOABSA:{"ao","quan","thoi trang","chat lieu vai","form dang","size"},
 VISD4SA:{"dien thoai","smartphone","may tinh","man hinh","camera","pin"},
}
BRAND_TERMS={
 VICLOABSA:{"coolmate","uniqlo","zara","hm","h m"},
 VISD4SA:{"samsung","apple","xiaomi","oppo","vivo","realme","redmi"},
}
_DOMAIN_LABELS={VICLOABSA:"Thời trang / Quần áo (ViCloABSA)",VISD4SA:"Điện thoại / Điện tử (ViSD4SA)"}
_LOCAL_MODEL_LOCK=Lock()
_LOCAL_MODEL_ATTEMPTED=False
_LOCAL_MODEL:Any=None
_LOCAL_TOKENIZER:Any=None
_LOCAL_LABELS:dict[int,str]={}


def _normalize(value:Any)->str:
 text=str(value or "").casefold().replace("đ","d")
 text=unicodedata.normalize("NFKD",text)
 text="".join(char for char in text if not unicodedata.combining(char))
 return re.sub(r"[^a-z0-9]+"," ",text).strip()


def _contains_phrase(text:str,phrase:str)->bool:
 return bool(text and phrase and (" "+phrase+" ") in (" "+text+" "))


def _as_strings(value:Any)->list[str]:
 if isinstance(value,str): return [value]
 if isinstance(value,(list,tuple,set)): return [str(item) for item in value if item is not None]
 return []


def _category_id_map()->dict[str,str]:
 mapping=dict(CATEGORY_ID_TO_SOURCE)
 raw=os.getenv("ABSA_DOMAIN_CATEGORY_ID_MAP","").strip()
 if raw:
  try:
   configured=json.loads(raw)
   if isinstance(configured,dict):
    mapping.update({str(key):str(source) for key,source in configured.items() if str(source) in ALLOWED_SOURCES})
  except (TypeError,ValueError):
   pass
 return mapping


def _category_match(product:dict[str,Any])->tuple[str|None,list[str],bool]:
 path=_as_strings(product.get("category_path"))
 category=_as_strings(product.get("category"))
 segments=[_normalize(item) for item in path+category]
 segments=[item for item in segments if item]
 ids=[str(item).strip() for item in _as_strings(product.get("category_ids"))]
 id_map=_category_id_map()
 found:set[str]=set()
 evidence:list[str]=[]
 for category_id in ids:
  source=id_map.get(category_id)
  if source in ALLOWED_SOURCES:
   found.add(source)
   evidence.append("Shopee category ID "+category_id)
 for source,terms in CATEGORY_TERMS.items():
  matched=[term for term in terms if any(segment==term or _contains_phrase(segment,term) for segment in segments)]
  if matched:
   found.add(source)
   evidence.extend("Danh mục: "+term for term in sorted(matched))
 if len(found)>1: return None,evidence,True
 if len(found)==1: return next(iter(found)),evidence,False
 return None,evidence,False


def _text_match(product:dict[str,Any])->tuple[str|None,float,str,list[str],bool]:
 name=_normalize(product.get("name"))
 description=_normalize(product.get("description"))
 scores:dict[str,float]={}
 methods:dict[str,str]={}
 evidence:dict[str,list[str]]={}
 for source in (VICLOABSA,VISD4SA):
  name_hits=sorted(term for term in STRONG_NAME_TERMS[source] if _contains_phrase(name,term))
  description_hits=sorted(term for term in DESCRIPTION_TERMS[source] if _contains_phrase(description,term))
  brand_hits=sorted(term for term in BRAND_TERMS[source] if _contains_phrase(name,term))
  description_brand_hits=sorted(term for term in BRAND_TERMS[source] if _contains_phrase(description,term))
  if name_hits:
   score=0.96 if any(term in {"iphone","samsung galaxy","dien thoai","ao thun"} for term in name_hits) else 0.93
   method="product_name_rules"
   hits=["Tên sản phẩm: "+term for term in name_hits]
  elif brand_hits:
   score=0.76
   method="product_name_rules"
   hits=["Thương hiệu trong tên: "+term for term in brand_hits]
  elif description_hits:
   score=0.76
   method="product_description_rules"
   hits=["Mô tả sản phẩm: "+term for term in description_hits]
  elif description_brand_hits:
   score=0.66
   method="product_description_rules"
   hits=["Thương hiệu trong mô tả: "+term for term in description_brand_hits]
  else:
   score=0.0
   method="none"
   hits=[]
  scores[source]=score
  methods[source]=method
  evidence[source]=hits
 ranked=sorted(scores.items(),key=lambda item:item[1],reverse=True)
 best_source,best_score=ranked[0]
 second_score=ranked[1][1]
 if best_score==0: return None,0.0,"none",[],False
 if second_score and best_score-second_score<0.15:
  return None,best_score,"conflicting_text_rules",evidence[VICLOABSA]+evidence[VISD4SA],True
 return best_source,best_score,methods[best_source],evidence[best_source],False


def _label_to_source(label:Any)->str|None:
 value=_normalize(label)
 aliases={
  VICLOABSA:VICLOABSA,"viclo absa":VICLOABSA,"clothing":VICLOABSA,"fashion":VICLOABSA,"thoi trang":VICLOABSA,
  VISD4SA:VISD4SA,"visd 4 sa":VISD4SA,"electronics":VISD4SA,"electronic":VISD4SA,"phone":VISD4SA,
  "smartphone":VISD4SA,"dien tu":VISD4SA,"dien thoai":VISD4SA,
 }
 return aliases.get(value)


def local_domain_model_configured()->bool:
 model_dir=os.getenv("ABSA_DOMAIN_MODEL_DIR","").strip()
 return bool(model_dir and Path(model_dir).is_dir())


def _load_local_model()->tuple[Any,Any,dict[int,str]]:
 global _LOCAL_MODEL_ATTEMPTED,_LOCAL_MODEL,_LOCAL_TOKENIZER,_LOCAL_LABELS
 if _LOCAL_MODEL_ATTEMPTED: return _LOCAL_MODEL,_LOCAL_TOKENIZER,_LOCAL_LABELS
 with _LOCAL_MODEL_LOCK:
  if _LOCAL_MODEL_ATTEMPTED: return _LOCAL_MODEL,_LOCAL_TOKENIZER,_LOCAL_LABELS
  _LOCAL_MODEL_ATTEMPTED=True
  model_dir=os.getenv("ABSA_DOMAIN_MODEL_DIR","").strip()
  if not model_dir or not Path(model_dir).is_dir(): return None,None,{}
  try:
   import torch
   from transformers import AutoModelForSequenceClassification,AutoTokenizer
   tokenizer=AutoTokenizer.from_pretrained(model_dir,local_files_only=True)
   model=AutoModelForSequenceClassification.from_pretrained(model_dir,local_files_only=True).to("cpu").eval()
   configured_labels=json.loads(os.getenv("ABSA_DOMAIN_MODEL_LABELS","{}"))
   labels:dict[int,str]={}
   for index,label in model.config.id2label.items():
    source=configured_labels.get(str(index)) if isinstance(configured_labels,dict) else None
    source=source or _label_to_source(label)
    if source in ALLOWED_SOURCES: labels[int(index)]=source
   if set(labels.values())!=ALLOWED_SOURCES: return None,None,{}
   _LOCAL_MODEL,_LOCAL_TOKENIZER,_LOCAL_LABELS=model,tokenizer,labels
  except Exception:
   return None,None,{}
 return _LOCAL_MODEL,_LOCAL_TOKENIZER,_LOCAL_LABELS


def _predict_local_model(product:dict[str,Any])->tuple[str,float,list[str]]|None:
 model,tokenizer,labels=_load_local_model()
 if model is None or tokenizer is None or not labels: return None
 try:
  import torch
  text=" ".join([str(product.get("name") or ""),str(product.get("description") or "")," ".join(_as_strings(product.get("category_path")))]).strip()
  if not text: return None
  encoded=tokenizer(text,truncation=True,max_length=256,return_tensors="pt")
  with torch.inference_mode(): probabilities=torch.softmax(model(**encoded).logits[0],dim=-1)
  candidates=[(labels[index],float(probabilities[index])) for index in labels if index<len(probabilities)]
  if not candidates: return None
  source,confidence=max(candidates,key=lambda item:item[1])
  return source,confidence,["Kết quả từ mô hình phân loại cục bộ"]
 except Exception:
  return None


def _result(source:str|None,confidence:float,method:str,evidence:list[str],*,reason:str|None=None)->dict[str,Any]:
 confidence=max(0.0,min(1.0,float(confidence)))
 if source not in ALLOWED_SOURCES or confidence<CONFIRM_THRESHOLD:
  status="unknown"
  selected_source=None
 elif confidence>=AUTO_THRESHOLD:
  status="auto_detected"
  selected_source=source
 else:
  status="confirmation_required"
  selected_source=None
 return {
  "source":selected_source,
  "suggested_source":source if source in ALLOWED_SOURCES else None,
  "domain_label":_DOMAIN_LABELS.get(source) if source in ALLOWED_SOURCES else None,
  "confidence":round(confidence,3),
  "method":method,
  "status":status,
  "requires_confirmation":status!="auto_detected",
  "evidence":evidence[:12],
  "reason":reason,
  "thresholds":{"automatic":AUTO_THRESHOLD,"confirmation":CONFIRM_THRESHOLD},
 }


def detect_product_domain(product:dict[str,Any])->dict[str,Any]:
 """Classify a product without guessing when evidence is weak or contradictory."""
 product=product if isinstance(product,dict) else {}
 category_source,category_evidence,category_conflict=_category_match(product)
 text_source,text_confidence,text_method,text_evidence,text_conflict=_text_match(product)
 if category_conflict:
  model_result=_predict_local_model(product)
  if model_result and model_result[1]>=AUTO_THRESHOLD:
   return _result(model_result[0],model_result[1],"local_text_model",category_evidence+model_result[2])
  return _result(None,0.0,"conflicting_category_metadata",category_evidence,reason="Danh mục hoặc category ID chứa tín hiệu thuộc nhiều lĩnh vực.")
 if category_source:
  if text_conflict or (text_source and text_source!=category_source and text_confidence>=AUTO_THRESHOLD):
   return _result(None,0.0,"metadata_text_conflict",category_evidence+text_evidence,reason="Danh mục Shopee và tên/mô tả sản phẩm mâu thuẫn.")
  return _result(category_source,0.98,"shopee_category",category_evidence)
 if text_conflict:
  model_result=_predict_local_model(product)
  if model_result and model_result[1]>=AUTO_THRESHOLD:
   return _result(model_result[0],model_result[1],"local_text_model",text_evidence+model_result[2])
  return _result(None,0.0,"conflicting_text_rules",text_evidence,reason="Tên hoặc mô tả có tín hiệu thuộc nhiều lĩnh vực.")
 if text_source and text_confidence>=AUTO_THRESHOLD:
  return _result(text_source,text_confidence,text_method,text_evidence)
 model_result=_predict_local_model(product)
 if model_result:
  model_source,model_confidence,model_evidence=model_result
  if text_source and text_source!=model_source and text_confidence>=CONFIRM_THRESHOLD:
   return _result(None,0.0,"model_text_conflict",text_evidence+model_evidence,reason="Mô hình cục bộ và luật từ khóa đưa ra hai lĩnh vực khác nhau.")
  if model_confidence>=CONFIRM_THRESHOLD:
   return _result(model_source,model_confidence,"local_text_model",text_evidence+model_evidence)
 if text_source:
  return _result(text_source,text_confidence,text_method,text_evidence)
 return _result(None,0.0,"none",[],reason="Không đủ metadata để xác định lĩnh vực an toàn.")
