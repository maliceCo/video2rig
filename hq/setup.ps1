# One-time setup for the HQ worker: Windows + NVIDIA GPU, needs `uv` and `ffmpeg` on PATH.
# Afterwards put SMPLX_NEUTRAL.npz in hq/body_models/smplx/ (see README).
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Invoke-Uv {
  & uv @args
  if ($LASTEXITCODE -ne 0) { throw "uv failed with exit code $LASTEXITCODE" }
}

Invoke-Uv venv --allow-existing --python 3.11 .venv
$env:VIRTUAL_ENV = Join-Path $PSScriptRoot ".venv"

# Match the known-good CUDA environment; install PyTorch before the pinned Python lock.
Invoke-Uv pip install "torch==2.7.1" "torchvision==0.22.1" --index-url https://download.pytorch.org/whl/cu128
# chumpy (legacy gvhmr dependency) breaks under PEP 517 build isolation.
Invoke-Uv pip install pip setuptools wheel "numpy==1.26.4"
Invoke-Uv pip install --no-build-isolation "chumpy==0.70"
Invoke-Uv pip install -r requirements-lock.txt --index-url https://pypi.org/simple --extra-index-url https://download.pytorch.org/whl/cu128 --index-strategy unsafe-best-match
# Finger tracking model code (weights come from setup_hands.py)
Invoke-Uv pip install --no-deps "git+https://github.com/warmshao/WiLoR-mini@ebec42f94c389070cdd7dda6fd1bf0b4a659c960"

# GVHMR / HMR2 / ViTPose checkpoints (~5 GB) into hq/weights.
$env:GVHMR_CHECKPOINTS = Join-Path $PSScriptRoot "weights"
$env:GVHMR_BODY_MODELS = Join-Path $PSScriptRoot "body_models"
$gvhmr = Join-Path $PSScriptRoot ".venv\Scripts\gvhmr.exe"
$env:PYTHONIOENCODING = "utf-8"
& $gvhmr download demo
if ($LASTEXITCODE -ne 0) { throw "gvhmr checkpoint verification failed with exit code $LASTEXITCODE" }
New-Item -ItemType Directory -Force body_models\smplx | Out-Null
if (Test-Path body_models\smplx\SMPLX_NEUTRAL.npz) {
  Write-Host "SMPL-X body model present."
} else {
  Write-Host "Now add body_models\smplx\SMPLX_NEUTRAL.npz (https://smpl-x.is.tue.mpg.de/, v1.1)."
}
Write-Host "Optional fingers: download mano_v1_2.zip (https://mano.is.tue.mpg.de) and run: .venv\Scripts\python setup_hands.py <zip>"
