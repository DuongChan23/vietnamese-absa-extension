"""Preserve source taxonomy labels; merge exact duplicate predictions only."""
from copy import deepcopy
from typing import Any, Mapping
VALID_SENTIMENTS={"positive","neutral","negative"}
MERGE_POLICY="source_preserving_exact_duplicate_v1"
def normalize_category(label:Any,source:str|None=None)->str:return str(label or "UNKNOWN").strip() or "UNKNOWN"
def normalize_sources(value:Any)->list[str]:
 values=[value] if isinstance(value,str) else list(value) if isinstance(value,(list,tuple,set)) else [];out=[]
 for x in values:
  n=str(x or "").strip()
  if n and n not in out:out.append(n)
 return out
def merge_unique(a:list,b:list)->list:
 out=list(a)
 for x in b:
  if x not in out:out.append(x)
 return out
def merge_aspects(aspects:list[dict[str,Any]],source:str|None=None)->list[dict[str,Any]]:
 out=[];positions={}
 for aspect in aspects:
  if not isinstance(aspect,dict):continue
  item=deepcopy(aspect);original=str(item.get("category") or "UNKNOWN").strip();item["category"]=normalize_category(original,source);item["sentiment"]=str(item.get("sentiment") or "").strip().lower();item["sources"]=normalize_sources(item.get("sources"))
  if source and source!="unified" and source not in item["sources"]:item["sources"].append(source)
  item["original_categories"]=[original];item["merged_count"]=1;s,e=item.get("start"),item.get("end")
  if not(type(s)is int and type(e)is int and 0<=s<e and item["sentiment"] in VALID_SENTIMENTS):out.append(item);continue
  key=(s,e,item["category"],item["sentiment"])
  if key not in positions:positions[key]=len(out);out.append(item);continue
  prev=out[positions[key]];prev["merged_count"]+=1;prev["sources"]=merge_unique(prev["sources"],item["sources"]);prev["original_categories"]=merge_unique(prev["original_categories"],[original])
 return out
def enrich_batch_response(response:Mapping[str,Any],source:str|None=None)->dict[str,Any]:
 out=deepcopy(dict(response));results=out.get("results")
 if not isinstance(results,list):raise ValueError("Batch response must contain a results list.")
 for row in results:
  if isinstance(row,dict) and isinstance(row.get("aspects"),list):row["aspects_merged"]=merge_aspects(row["aspects"],source)
 out["category_merge_policy"]=MERGE_POLICY;return out
