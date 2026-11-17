# SmartCapture

SmartCapture guarda capturas de pantalla mientras recorres manualmente lecciones de Cisco Networking Academy (CCNA2). Es una página estática escrita en HTML, CSS y JavaScript, en español y con interfaz oscura. Las capturas se procesan y almacenan en el navegador. Puedes usar el PDF o el ZIP resultante para preparar material de estudio con la herramienta que elijas.

## Cómo usarlo

1. Abre SmartCapture en una versión actual de Chrome o Brave desde una URL HTTPS o desde `localhost`.
2. Pulsa **Compartir fuente** y elige en el selector del navegador una pestaña, ventana o pantalla. Compartir solo la pestaña de NetAcad evita capturar otras aplicaciones y la vista previa de SmartCapture.
3. Para recortar la imagen, pulsa **Seleccionar región** y arrastra sobre la vista previa. **Imagen completa** restablece el encuadre. Si cambias el tamaño de la fuente o el contenido se mueve dentro de la ventana, comprueba el recorte.
4. Pulsa **Iniciar captura** y navega por el curso. Mantén cada vista quieta al menos un segundo. El primer contenido estable también se guarda.
5. Ajusta el tiempo de espera si las animaciones tardan en asentarse. Sube la sensibilidad si se omiten cambios de poco contraste. Si un cursor, reloj o animación impide la estabilidad, exclúyelo del recorte o usa **Captura manual**.
6. Usa **Pausar captura** y **Reanudar captura** para controlar la detección automática. La captura manual sigue disponible durante la pausa. **Finalizar y dejar de compartir** libera la fuente y conserva la galería.
7. Pulsa una miniatura para ampliar la captura. Usa **Tamaño original** para inspeccionar detalles. Arrastra las tarjetas o usa sus flechas para cambiar el orden. El botón **Eliminar** borra la captura de la galería.
8. Exporta el orden actual como **PDF** de una imagen por página o **ZIP** de PNG numerados. El PDF conserva la cuadrícula de píxeles y comprime el RGB sin pérdida. El ZIP incluye los PNG originales.

## Publicación en GitHub Pages

1. Sube `index.html`, `style.css`, `app.js`, `detection.js`, `sampling.js`, `sample-clock.js`, `storage.js` y `exports.js` a la raíz de `main`.
2. En GitHub, abre **Settings → Pages**. Elige **Deploy from a branch**, selecciona **main** y **/ (root)**, y guarda.
3. Cuando termine el despliegue, abre la URL HTTPS indicada en **Pages**. Para este repositorio, la URL predeterminada es `https://kamexd.github.io/CCNA2/`. Prueba **Compartir fuente** desde esa página.

Para probar localmente con Node.js instalado, ejecuta `npx --yes http-server . -a 127.0.0.1 -p 8080` desde la raíz y abre `http://localhost:8080/`. El servidor es solo una herramienta opcional de desarrollo. La aplicación publicada sirve archivos estáticos y no instala dependencias de ejecución.

## Detección y almacenamiento

- El navegador proporciona un flujo temporal de video para la vista previa y el análisis. SmartCapture analiza la región a la resolución disponible aproximadamente cuatro veces por segundo y guarda únicamente imágenes.
- La detección combina una comparación global con pruebas de contraste en regiones vecinas de 16 × 16 píxeles. Así puede distinguir un comando o diagrama localizado aunque casi toda la pantalla siga igual. La sensibilidad ajusta el contraste y la cantidad de píxeles necesarios. La captura manual omite estos umbrales y la espera.
- La captura pide excluir el cursor cuando el navegador lo permite. Si el cursor aparece en el flujo, la comparación puede ignorar desplazamientos de un patrón compacto, oscuro y claro. Los cursores personalizados, sobre fondos complejos o parcialmente tapados aún pueden activar la detección.
- Un hash de los píxeles y las dimensiones evita duplicados exactos en toda la galería, incluida la captura manual. Para la captura automática, una comparación adicional a resolución original descarta similitudes por ruido leve o por un desplazamiento reconocible del cursor. También funciona con PNG guardados por versiones anteriores. La captura manual permite conservar variantes visualmente similares.
- IndexedDB guarda los PNG, las miniaturas y el orden. Los datos pertenecen al perfil y origen actuales. Una recarga conserva la galería y termina la sesión de pantalla. El modo privado, el borrado de datos del sitio o las políticas y cuotas del navegador pueden limitar la persistencia. Exporta antes de depender de esos datos como respaldo.
- Para exportar se procesa una imagen original a la vez. Los archivos resultantes se construyen en el navegador y su tamaño puede afectar a dispositivos con poca memoria. El ZIP clásico admite hasta 65 535 entradas y menos de 4 GiB. Para sesiones grandes, exporta en tandas.

## Limitaciones del navegador

- El permiso de captura requiere una acción del usuario y se vuelve a solicitar para cada fuente. El navegador decide qué fuentes ofrece, qué resolución entrega y cuándo suspende o finaliza el flujo. Un sitio protegido puede aparecer en negro. La aplicación usa solo los píxeles autorizados por el selector del navegador.
- Si Chromium ofrece acceso directo a los fotogramas, el análisis puede avanzar aunque la vista previa deje de repintarse. Un temporizador en un Web Worker mantiene el muestreo de vistas estáticas y respalda la captura mediante la vista previa. Chromium aún puede espaciar la ejecución, congelar pestañas ocultas o reducir los fotogramas. Minimizar la fuente, bloquear el equipo o dejarlo en suspensión también puede interrumpir la entrega. Los cambios entre muestras y las vistas breves pueden pasar inadvertidos. Si aparecen omisiones, mantén SmartCapture visible cuando sea posible o usa la captura manual.
- La máxima resolución del PNG es la del flujo que Chrome o Brave entrega para la fuente y el recorte elegidos. El tamaño de la vista previa no altera esa resolución.

## Verificación

Ejecuta `node --test tests/detection.mjs` para las pruebas de detección. Con Node.js 22 o posterior y Chromium instalado, ejecuta `node tests/interactive.mjs` para compartir una pestaña interactiva real, o añade `--preview` para comprobar la ruta que usa la vista previa. Puedes indicar el ejecutable mediante la variable `CHROMIUM`.

- En Chromium 156 para Linux, la prueba interactiva compartió una pestaña real con `getDisplayMedia` y mantuvo SmartCapture oculta. Verificó cambios de texto y diagrama mediante botones y pestañas, movimientos cortos y largos del cursor, duplicados de vistas anteriores, lectura de capturas antiguas y resolución del PNG. Pasó con lectura directa de fotogramas y con la ruta de vista previa.
- Un flujo de video sintético en Chromium permitió comprobar el recorte, la espera de estabilidad, cambios de pocos píxeles, duplicados, pausa, captura manual, reanudación, finalización, reordenación, ampliación, eliminación y persistencia después de recargar. También se comprobaron los umbrales RGB y el ajuste de la espera en Node.js.
- Se comprobó la integridad del ZIP y se compararon las tres imágenes de una exportación de prueba con las imágenes extraídas del PDF. Coincidieron píxel a píxel y en el mismo orden.

Quedan por comprobar en Windows 11 el selector de pestaña, ventana y pantalla en Chrome y Brave y las sesiones largas con la aplicación oculta. La verificación se hizo con contenido de prueba.

Para la revisión en Windows 11, prueba las tres fuentes, selecciona una región con texto pequeño y cambia un carácter. Comprueba el contador, intercambia dos imágenes y revisa el orden en PDF y ZIP. Deja la aplicación en segundo plano varios minutos y vuelve a cambiar de lección para comprobar cómo se comporta con la configuración de ahorro de recursos de ese navegador.
