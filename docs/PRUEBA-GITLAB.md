# Compartir una version de prueba desde GitLab

## Preparar una Release

1. Incluye `instalar.bat`, `iniciar.bat` y este documento en el commit que quieras compartir.
2. Haz push del commit a GitLab.
3. En el proyecto, crea una Release desde ese commit y asignale un tag, por ejemplo `v0.1.0`.
4. En la descripcion de la Release, indica que es una version de prueba para Windows y que hay que descargar el ZIP de **Source code**.
5. Comparte el enlace de la Release. Si el proyecto es privado, primero da acceso a tu amigo como miembro del proyecto.

GitLab genera los archivos ZIP/TAR del codigo fuente para el tag. No hace falta compilar un instalador ni configurar CI/CD. El archivo contiene los archivos versionados en ese commit; los archivos locales no versionados no se incluyen.

## Instrucciones para quien lo prueba

### Requisitos

- Windows 10/11.
- Node.js LTS, `uv` y `ffmpeg` instalados y disponibles en `PATH`.
- GPU NVIDIA y sus drivers para usar el procesamiento HQ.
- Conexion a Internet para la instalacion y para cargar los recursos de la aplicacion.

Descarga y extrae el ZIP completo. Ejecuta `instalar.bat`: prepara el entorno de Python y descarga los pesos publicos de HQ, lo que puede tardar y ocupar varios GB. No hace falta ejecutar `npm install` para iniciar la aplicacion.

### Modelos con registro

Algunos modelos no se distribuyen en el ZIP por sus condiciones de acceso/licencia; cada persona debe descargarlos con su propia cuenta:

1. **SMPL-X v1.1 (NPZ)** — requerido para HQ. Descarga `SMPLX_NEUTRAL.npz` desde [smpl-x.is.tue.mpg.de](https://smpl-x.is.tue.mpg.de/) y colocalo en:

   ```text
   hq\body_models\smplx\SMPLX_NEUTRAL.npz
   ```

2. **MANO (Models & Code)** — opcional; activa WiLoR para el seguimiento de dedos. Descarga `mano_v1_2.zip` desde [mano.is.tue.mpg.de](https://mano.is.tue.mpg.de/) y colocalo en:

   ```text
   hq\body_models\mano_v1_2.zip
   ```

   Vuelve a ejecutar `instalar.bat`; el script convierte el modelo y descarga los pesos necesarios. Sin MANO, el seguimiento de dedos utiliza MediaPipe.

Al final de `instalar.bat` se muestran de nuevo las rutas exactas y si SMPL-X falta. Si se anade SMPL-X despues, no hace falta reinstalar: basta con iniciar el servidor y arrancar el worker HQ desde la aplicacion.

### Iniciar

Ejecuta `iniciar.bat`. Deja abierta la ventana **Prompt2Rig - servidor** y abre la aplicacion en <http://localhost:5177>. El procesamiento HQ se puede iniciar desde el control **start hq worker** de la aplicacion.

Para generar videos o imagenes a partir de prompts, configura una clave personal de fal en `.env` (`FAL_KEY=...`). Las llamadas al servicio pueden tener coste. Sin esa clave se pueden probar los videos locales; el archivo de video se procesa localmente.

Los componentes de HQ tienen licencias y condiciones propias. En particular, SMPL-X, MANO, GVHMR y WiLoR tienen restricciones no comerciales; consulta la tabla de licencias del README antes de usarlos fuera de una prueba personal.
