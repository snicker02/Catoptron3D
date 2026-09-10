# EXPERIMENT, not part of the app.
#
# Builds a flame attractor by CHAOS GAME into a voxel grid instead of estimating a distance to it.
# The chaos game is the attractor's definition, so this needs no container, no selection rule and
# no Lipschitz bound — the three things that produce every artifact the flame path suffers from.
#
# Run:  python3 tools/voxel-experiment.py   (writes /tmp/occ.npy)
#       python3 tools/voxel-render.py       (renders it)
#
# Measured on a 5-xform flame with a rotated transform: 1.15 s for 4 million points, 0.89 s to
# voxelise, 4.6% occupancy of a 256^3 grid, voxel size 0.017 world units.
#
# The trade is the point: EXACT but resolution-limited, against ESTIMATED but unlimited. At a
# close camera the 256^3 grid reads as blobs, and a naive half-voxel march costs about a second a
# frame. It is not a drop-in replacement; it is a different tool for a different job.
import numpy as np, json, subprocess, time, sys
J=json.loads(subprocess.check_output(['node','/tmp/b2.mjs']).decode())
M=J['maps']
Mf=np.array([m['M'] for m in M]).reshape(-1,3,3); Tf=np.array([m['T'] for m in M])
n=len(M)
t0=time.time()
# chaos game: the attractor is DEFINED by this, so it needs no estimator and no selection rule
N=4_000_000; B=200_000
rng=np.random.default_rng(1)
P=np.zeros((B,3))
for _ in range(20):                     # burn-in
    k=rng.integers(n,size=B); P=np.einsum('nij,nj->ni',Mf[k],P)+Tf[k]
pts=[]
for _ in range(N//B):
    k=rng.integers(n,size=B); P=np.einsum('nij,nj->ni',Mf[k],P)+Tf[k]
    pts.append(P.copy())
A=np.concatenate(pts)
print("chaos game: %.2f s for %d points" % (time.time()-t0, len(A)))
lo=A.min(0); hi=A.max(0); pad=(hi-lo)*0.02; lo-=pad; hi+=pad
G=256
t0=time.time()
idx=np.clip(((A-lo)/(hi-lo)*G).astype(np.int32),0,G-1)
occ=np.zeros((G,G,G),np.uint8)
occ[idx[:,0],idx[:,1],idx[:,2]]=255
print("voxelise:   %.2f s   occupancy %.2f%% of %d^3" % (time.time()-t0, 100*(occ>0).mean(), G))
np.save('/tmp/occ.npy', occ); np.save('/tmp/bounds.npy', np.stack([lo,hi]))
print("grid bounds", np.round(lo,3), np.round(hi,3))
print("voxel size  %.5f world units" % ((hi-lo).max()/G))
