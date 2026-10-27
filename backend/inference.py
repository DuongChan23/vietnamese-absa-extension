"""Inference-only reconstruction of ACTIVE NB39 -> NB46 -> NB04.
No DEV labels, no gold proposals, no NB20 inference, no retraining.
Run from project root. Model layout documented in README.md.
"""
from __future__ import annotations
import hashlib
import json
import os
import shutil
from pathlib import Path
import torch
from torch import nn
from transformers import AutoModel, AutoTokenizer, AutoModelForSequenceClassification
import py_vncorenlp

ROOT = Path(__file__).resolve().parents[1]
MODELS = Path(os.getenv('ABSA_MODELS_DIR', str(ROOT/'models')))
SOURCE = MODELS/'ate_category_conditioned_v1'/'model'
JOINT = MODELS/'absa_joint_biaffine_span_pair_v1'
NB46 = MODELS/'absa_joint46_boundary_ranking_pilot_v1'
ASC = MODELS/'phobert_asc_training'/'model'
DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

def sha256(path):
    d=hashlib.sha256()
    with Path(path).open('rb') as f:
        for chunk in iter(lambda:f.read(4*1024*1024), b''):
            d.update(chunk)
    return d.hexdigest()

class JointBiaffine(nn.Module):
    def __init__(self, name, dim=128):
        super().__init__()
        self.encoder=AutoModel.from_pretrained(name)
        h=self.encoder.config.hidden_size
        self.boundary=nn.Linear(h,2)
        self.presence=nn.Linear(h,1)
        self.start_proj=nn.Sequential(nn.Dropout(.1),nn.Linear(h,dim),nn.GELU())
        self.end_proj=nn.Sequential(nn.Dropout(.1),nn.Linear(h,dim),nn.GELU())
        self.biaffine=nn.Parameter(torch.empty(dim+1,dim+1))
        nn.init.xavier_uniform_(self.biaffine)
        self.pair_context=nn.Linear(h,1)
    def pair_logits(self, st,en,cls,pairs):
        if not pairs: return st.new_empty((0,))
        i=torch.as_tensor([x for x,y in pairs],device=st.device)
        j=torch.as_tensor([y for x,y in pairs],device=st.device)
        a=torch.cat([st[i],torch.ones_like(st[i,:1])],-1)
        b=torch.cat([en[j],torch.ones_like(en[j,:1])],-1)
        return torch.einsum('nd,df,nf->n',a,self.biaffine,b)+self.pair_context(cls).reshape(())

class BoundaryReranker(nn.Module):
    def __init__(self, hidden=768,mid=128):
        super().__init__()
        self.net=nn.Sequential(nn.Linear(hidden*4+1,mid),nn.GELU(),nn.Dropout(.15),nn.Linear(mid,1))
        nn.init.zeros_(self.net[-1].weight);nn.init.zeros_(self.net[-1].bias)
    def forward(self,h,cls,pairs,old_logits):
        if not pairs:return old_logits
        pieces=[]
        for idx,(i,j) in enumerate(pairs):
            inside=h[i:j+1].mean(dim=0)
            pieces.append(torch.cat([h[i],h[j],inside,cls,old_logits[idx:idx+1].detach()]))
        return old_logits.float()+self.net(torch.stack(pieces)).squeeze(-1).float()

class ABSAPredictor:
    def __init__(self):
        config=json.loads((SOURCE/'model_config.json').read_text(encoding='utf-8'))
        pol=json.loads((JOINT/'locked_policy.json').read_text(encoding='utf-8'))
        pol46=json.loads((NB46/'pilot_policy.json').read_text(encoding='utf-8'))
        self.categories=config['categories'];self.max_len=int(config['max_len']);self.max_chars=int(config['max_span_chars'])
        self.top_start=int(pol['pair_top_start']);self.top_end=int(pol['pair_top_end'])
        self.max_pairs=int(pol['max_pairs']);self.max_spans=int(pol['max_spans_per_query'])
        self.threshold=float(pol46['threshold'])
        assert pol['selected_without_dev'] and pol46['chosen_without_dev']
        assert (self.max_len,self.max_chars,self.top_start,self.top_end,self.max_pairs,self.max_spans)==(384,256,12,16,48,4)
        assert sha256(JOINT/'joint_best.pt')==pol46['base_checkpoint_sha256'], 'NB39/NB46 SHA mismatch'
        if 'source_nb20_sha256' in pol46:
            assert sha256(SOURCE/'conditional_span.pt')==pol46['source_nb20_sha256'], 'NB20 provenance mismatch'
        self.tk=AutoTokenizer.from_pretrained(SOURCE,use_fast=True)
        assert self.tk.is_fast
        self.joint=JointBiaffine(config.get('model_name','xlm-roberta-base'))
        self.joint.load_state_dict(torch.load(JOINT/'joint_best.pt',map_location='cpu',weights_only=True),strict=True)
        self.joint.to(DEVICE).eval()
        self.rerank=BoundaryReranker(self.joint.encoder.config.hidden_size)
        self.rerank.load_state_dict(torch.load(NB46/'reranker_best.pt',map_location='cpu',weights_only=True),strict=True)
        self.rerank.to(DEVICE).eval()
        # Compatibility with tokenizer_config.json containing extra_special_tokens as a list.
        # Copy tokenizer-only files to a local temporary directory; never change Drive artifacts.
        import tempfile
        self._tokenizer_tmp=tempfile.TemporaryDirectory(prefix='absa_asc_tk_')
        temp_dir=Path(self._tokenizer_tmp.name)
        for pattern in ('*.json','*.txt','*.model','*.bpe','*.codes','*.vocab'):
            for file in ASC.glob(pattern):
                if file.is_file() and file.name not in ('config.json','generation_config.json'):
                    shutil.copy2(file,temp_dir/file.name)
        config_path=temp_dir/'tokenizer_config.json'
        tkconf=json.loads(config_path.read_text(encoding='utf-8'))
        if isinstance(tkconf.get('extra_special_tokens'),list):
            tkconf.pop('extra_special_tokens')
            config_path.write_text(json.dumps(tkconf,ensure_ascii=False),encoding='utf-8')
        self.asc_tk=AutoTokenizer.from_pretrained(temp_dir,use_fast=False)
        self.asp_start=self.asc_tk.convert_tokens_to_ids('[ASP]')
        self.asp_end=self.asc_tk.convert_tokens_to_ids('[/ASP]')
        assert self.asp_start!=self.asp_end and self.asp_start!=self.asc_tk.unk_token_id and self.asp_end!=self.asc_tk.unk_token_id
        self.asc=AutoModelForSequenceClassification.from_pretrained(ASC).to(DEVICE).eval()
        assert len(self.asc_tk)==self.asc.get_input_embeddings().weight.shape[0]
        self.labels={0:'negative',1:'neutral',2:'positive'}
        vn_dir=Path(os.getenv('ABSA_VNCORENLP_DIR',str(ROOT/'vncorenlp')))
        if not (vn_dir/'VnCoreNLP-1.2.jar').exists():
            raise FileNotFoundError(f'VnCoreNLP not installed in {vn_dir}. See README.')
        self.segmenter=py_vncorenlp.VnCoreNLP(annotators=['wseg'],save_dir=str(vn_dir))
        self.segmenter.word_segment('Pin tốt nhưng màn hình mờ.')

    def _proposals(self, offsets, ps,pe):
        valid=[i for i,v in enumerate(offsets) if v is not None]
        starts=sorted(valid,key=lambda i:float(ps[i]),reverse=True)[:self.top_start]
        ends=sorted(valid,key=lambda i:float(pe[i]),reverse=True)[:self.top_end]
        opts=[]
        for i in starts:
            for j in ends:
                if j<i:continue
                s=offsets[i][0];e=offsets[j][1]
                if s<e and e-s<=self.max_chars: opts.append((float(ps[i]*pe[j]),i,j))
        opts.sort(reverse=True)
        return list(dict.fromkeys((i,j) for _,i,j in opts[:self.max_pairs]))

    def _segment_piece(self,piece):
        if not piece.strip():return ''
        try:
            sentences=self.segmenter.word_segment(piece)
            out=' '.join(sentences).strip()
            if not out:raise ValueError('empty')
            return out
        except Exception:
            return ' '.join(piece.split()) # Mirrors NB04 fallback; monitor in real deployment.

    def _asc_ids(self,text,s,e):
        a=self._segment_piece(text[:s]);b=self._segment_piece(text[s:e]);c=self._segment_piece(text[e:])
        left=self.asc_tk.encode(a,add_special_tokens=False) if a else []
        aspect=self.asc_tk.encode(b,add_special_tokens=False)
        right=self.asc_tk.encode(c,add_special_tokens=False) if c else []
        fixed=len(aspect)+4
        if not aspect or fixed>256:return None
        budget=256-fixed
        l_take=min(len(left),budget//2);r_take=min(len(right),budget-l_take)
        available=budget-l_take-r_take
        if available:
            extra_left=min(available,len(left)-l_take);l_take+=extra_left;available-=extra_left
        if available:
            extra_right=min(available,len(right)-r_take);r_take+=extra_right
        ids=[self.asc_tk.bos_token_id]+(left[-l_take:] if l_take else [])
        ids += [self.asp_start]+aspect+[self.asp_end]+right[:r_take]+[self.asc_tk.eos_token_id]
        return ids

    @torch.inference_mode()
    def predict_unified(self, text):
        """Run both learned source-conditioned category vocabularies.

        No inferred ontology mappings: categories keep their source namespace.
        Only exact duplicates with the same category string and sentiment merge.
        This inference mode has NOT been validated by the NB55 F1 metric.
        """
        predictions = {}
        for source in self.categories:
            for item in self.predict(text, source):
                key=(item['start'], item['end'], item['category'], item['sentiment'])
                if key not in predictions:
                    predictions[key]={**item, 'sources':[source]}
                elif source not in predictions[key]['sources']:
                    predictions[key]['sources'].append(source)
        return sorted(predictions.values(), key=lambda a:(a['start'],a['end'],a['category'],a['sentiment']))

    @torch.inference_mode()
    def predict(self,text,source):
        if source not in self.categories:
            raise ValueError(f'Unknown source: {source}. Supported: {list(self.categories)}')
        # Inference query uses empty gold; predictions never see DEV labels.
        candidates=set()
        for category in self.categories[source]:
            enc=self.tk(f'{source} aspect: {category}',text,truncation=False,return_offsets_mapping=True)
            if len(enc['input_ids'])>self.max_len:continue
            offsets=[(s,e) if q==1 and e>s else None for (s,e),q in zip(enc['offset_mapping'],enc.sequence_ids())]
            if not any(x is not None for x in offsets):continue
            ids=torch.tensor([enc['input_ids']],device=DEVICE)
            h=self.joint.encoder(input_ids=ids,attention_mask=torch.ones_like(ids)).last_hidden_state
            edges=self.joint.boundary(h)
            st=self.joint.start_proj(h);en=self.joint.end_proj(h)
            pairs=self._proposals(offsets,torch.sigmoid(edges[0,:,0]).cpu(),torch.sigmoid(edges[0,:,1]).cpu())
            if not pairs:continue
            logits=self.joint.pair_logits(st[0],en[0],h[0,0],pairs).detach().float()
            new=self.rerank(h[0],h[0,0],pairs,logits)
            scores=torch.sigmoid(new).cpu().tolist()
            ranked=sorted([(v,offsets[i][0],offsets[j][1]) for v,(i,j) in zip(scores,pairs)],reverse=True)
            chosen=[]
            for v,a,b in ranked:
                if v<self.threshold:break
                if any(max(a,x)<min(b,y) for x,y in chosen):continue
                chosen.append((a,b));candidates.add((a,b,category))
                if len(chosen)>=self.max_spans:break
        spans=sorted({(s,e) for s,e,_ in candidates})
        sentiments={}
        for s,e in spans:
            asc_ids=self._asc_ids(text,s,e)
            if asc_ids is None:continue
            ids=torch.tensor([asc_ids],device=DEVICE)
            att=(ids!=self.asc_tk.pad_token_id).long()
            label=int(self.asc(input_ids=ids,attention_mask=att).logits.argmax(-1).item())
            sentiments[(s,e)]=self.labels[label]
        return [{'start':s,'end':e,'aspect':text[s:e],'category':cat,'sentiment':sentiments[(s,e)]}
                for s,e,cat in sorted(candidates) if (s,e) in sentiments]
