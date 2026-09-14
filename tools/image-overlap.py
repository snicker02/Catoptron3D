# Does a flame's transforms have genuinely OVERLAPPING images?
#
# This decides whether a better container can help. "Image box" is exact only while the images are
# disjoint. If the AABB of each image is what overlaps, a tighter container fixes it. If the IMAGES
# THEMSELVES overlap, no container helps: a point really does have several valid preimages, and the
# only correct estimate is the minimum over branches — which is what Search width approximates.
#
# Run: python3 tools/image-overlap.py
import numpy as np, json, subprocess
# f_i(H) exactly:  p is in it  <=>  f_i^-1(p) is in H.  No AABB, so no inflation.
J=json.loads(subprocess.check_output(['node','-e','''
Promise.all([import("/home/claude/catoptron3d/engine/flame.js")]).then(([F])=>{
 const X=o=>({M:[1,0,0,0,1,0,0,0,1],T:[0,0,0],scale:1,rot:[0,0,0],tr:[0,0,0],
   vari:0,vamt:1,vp:F.defaultVP(),chaos:null,on:true,weight:0.5,...o});
 const flames={
  brad:[X({T:[1,-1,0],rot:[0,-106.5,0],vamt:0.5}),X({T:[1,1,0],vamt:0.5}),
        X({T:[-1,1,0],vamt:0.5}),X({T:[-1,-1,0],vamt:0.5}),
        X({M:[0.5,0,0,0,0.5,0,0,0,0.5],rot:[70.5,-1,0],tr:[0.015,-0.67,0.64],vari:1,vamt:1.565,weight:1})],
  rot131:[X({T:[1,-1,0],rot:[131,-91,0],vamt:0.5}),X({T:[1,1,0],vamt:0.5}),
        X({T:[-1,1,0],tr:[0.295,-0.12,1.395],vamt:0.5}),X({T:[-1,-1,0],vamt:0.5}),
        X({M:[0.5,0,0,0,0.5,0,0,0,0.5],tr:[-0.465,0.225,0],vamt:1.565,weight:1})]};
 const out={};
 for(const k in flames){ const f={name:k,select:2,maps:flames[k]}; const r=F.resolveFlame(f);
   out[k]={maps:r.map(m=>({Mi:m.Mi,Ti:m.Ti,M:m.M,T:m.T,vamt:m.vamt,expand:m.expand,vari:m.vari,
                           blo:m.blo,bhi:m.bhi})), hull:r.hull}; }
 console.log(JSON.stringify(out));
});''']).decode())
def sdbox(p,lo,hi):
    c=(lo+hi)*0.5; h=(hi-lo)*0.5; q=np.abs(p-c)-h
    return np.linalg.norm(np.maximum(q,0),axis=-1)+np.minimum(np.max(q,axis=-1),0)
for name,F in J.items():
    M=F['maps']; HL=F['hull']
    HLO=np.array(HL['lo']); HHI=np.array(HL['hi']); n=len(M)
    Mi=np.array([m['Mi'] for m in M]).reshape(-1,3,3); Ti=np.array([m['Ti'] for m in M])
    VA=np.array([m['vamt'] for m in M]); EX=np.array([m['expand'] for m in M])/np.abs(VA)
    BLO=np.array([m['blo'] for m in M]); BHI=np.array([m['bhi'] for m in M])
    # sample the hull densely and ask which maps' images each point belongs to
    rng=np.random.default_rng(3)
    P=rng.uniform(HLO,HHI,size=(200000,3))
    aabb=np.stack([sdbox(P,BLO[i],BHI[i])<=0 for i in range(n)],1)
    exact=np.stack([sdbox((np.einsum('ij,nj->ni',Mi[i],P/VA[i])+Ti[i]),HLO,HHI)<=0
                    for i in range(n)],1)
    print(f"=== {name} ===")
    for lbl,B in (('AABB of image',aabb),('exact image ',exact)):
        cover=B.any(1).mean()
        multi=(B.sum(1)>1).mean()
        amb = multi/max(cover,1e-9)
        # pairwise overlap count
        ov=0; pairs=0
        for i in range(n):
            for j in range(i+1,n):
                pairs+=1
                if (B[:,i]&B[:,j]).any(): ov+=1
        print(f"  {lbl}: covers {100*cover:5.1f}% of the hull, "
              f"{100*amb:5.1f}% of covered points are AMBIGUOUS, {ov}/{pairs} pairs overlap")
