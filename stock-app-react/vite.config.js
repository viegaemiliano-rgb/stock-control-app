import { defineConfig } from 'vite'
    import react from '@vitejs/plugin-react'

    // Reemplaza [nombre-del-repo] con el nombre de tu repositorio en GitHub (ej., /stock-control-app/)
    const REPO_NAME = '/stock-control-app/'; 

    export default defineConfig({
      // ¡ESTO ES LO NUEVO!
      base: /stock-control-app/, 
      plugins: [react()],
    })
    ```
    *Ejemplo: Si tu repositorio se llama `stock-control-app`, la línea sería `base: '/stock-control-app/'`.*

3.  **Recompila la Aplicación:**
    Regresa a tu terminal local y ejecuta el comando de compilación:
    ```bash
    npm run build
    ```
    *Esto regenerará la carpeta `dist` con las rutas correctas.*

4.  **Vuelve a Desplegar en GitHub Pages:**
    Ejecuta el comando que sube los archivos compilados a la rama `gh-pages`:
    ```bash
    npm run deploy