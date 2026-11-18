# SmartCapture

SmartCapture guarda capturas de pantalla mientras recorres manualmente lecciones de Cisco Networking Academy (CCNA2). Es una página estática escrita en HTML, CSS y JavaScript, en español y con interfaz oscura. Las capturas se procesan y almacenan en el navegador. Puedes usar el PDF o el ZIP resultante para preparar material de estudio con la herramienta que elijas.

## Cómo usarlo

En **Álbum activo** puedes crear, elegir o renombrar un álbum. Las capturas y las importaciones nuevas se guardan en ese álbum. Usa **Mover a álbum…** en una tarjeta para añadirla al final de otro álbum. Pausa la captura automática antes de cambiar de álbum.

Cada álbum conserva su galería, su orden y su papelera. PDF y ZIP exportan solo la galería del álbum activo. Al eliminar un álbum se pide confirmación para borrar definitivamente su galería y su papelera. Si eliminas el último, SmartCapture crea un álbum «General» vacío.

Activa **Selección múltiple** y pulsa las miniaturas en el orden que quieras trasladarlas. **Seleccionar todas** añade las que falten en el orden de la galería. Puedes insertar el lote al principio, al final o en una posición de otro álbum. La posición 1 corresponde al principio. **Eliminar seleccionadas** envía el lote a la papelera y permite restaurar las posiciones originales. Ambas operaciones en lote requieren confirmación.

1. Abre SmartCapture en una versión actual de Chrome o Brave desde una URL HTTPS o desde `localhost`.
2. Pulsa **Compartir fuente** y elige en el selector del navegador una pestaña, ventana o pantalla. Compartir solo la pestaña de NetAcad evita capturar otras aplicaciones y la vista previa de SmartCapture.
3. Para recortar la imagen, pulsa **Seleccionar región** y arrastra sobre la vista previa. **Imagen completa** restablece el encuadre. Si cambias el tamaño de la fuente o el contenido se mueve dentro de la ventana, comprueba el recorte.
4. Pulsa **Iniciar captura** y navega por el curso. Mantén cada vista quieta al menos un segundo. El primer contenido estable también se guarda.
5. Ajusta el tiempo de espera si las animaciones tardan en asentarse. Sube la sensibilidad si se omiten cambios de poco contraste. Si un cursor, reloj o animación impide la estabilidad, exclúyelo del recorte o usa **Captura manual**.
6. Usa **Pausar captura** y **Reanudar captura** para controlar la detección automática. La captura manual sigue disponible durante la pausa. **Finalizar y dejar de compartir** libera la fuente y conserva la galería.
7. Si el contenido tiene márgenes laterales vacíos, activa **Recortar márgenes laterales vacíos** antes de capturar. El recorte conserva la escala original y se aplica a las nuevas capturas.
8. Pulsa una miniatura para abrir el visor. Navega en el orden actual de la galería con las flechas del visor o del teclado. Usa **Tamaño original** para inspeccionar detalles y **Escape** para cerrar el visor.
9. Arrastra las tarjetas, usa sus flechas o pulsa **Mover a…** y escribe una posición. **Eliminar** envía una imagen a la papelera desde la galería o el visor. **Eliminar todas** envía todas las imágenes a la papelera y pausa la captura automática si está activa. Usa **Deshacer** en la notificación o abre **Papelera** para ampliar, restaurar o eliminar definitivamente las imágenes. Solo las eliminaciones definitivas piden confirmación.
10. Para incorporar imágenes PNG, JPG/JPEG o WEBP, usa **Adjuntar imágenes**, pega con **Ctrl + V** o suelta los archivos en la galería. En **Insertar**, elige **Al final** o indica si deben ir antes o después de una imagen y escribe su número actual.
11. Exporta el orden actual como **PDF** de una imagen por página o **ZIP** de archivos numerados en su formato original. El PDF conserva las dimensiones de píxeles y comprime el RGB sin pérdida. En PDF, las transparencias se muestran sobre blanco y los archivos animados se representan como una imagen estática. El ZIP conserva los bytes originales.

## Publicación en GitHub Pages

1. Sube `index.html`, `style.css`, `app.js`, `detection.js`, `capture-analysis.js`, `sampling.js`, `sample-clock.js`, `storage.js`, `trash.js` y `exports.js` a la raíz de `main`.
2. En GitHub, abre **Settings → Pages**. Elige **Deploy from a branch**, selecciona **main** y **/ (root)**, y guarda.
3. Cuando termine el despliegue, abre la URL HTTPS indicada en **Pages**. Para este repositorio, la URL predeterminada es `https://kamexd.github.io/CCNA2/`. Prueba **Compartir fuente** desde esa página.

Para probar localmente con Node.js instalado, ejecuta `npx --yes http-server . -a 127.0.0.1 -p 8080` desde la raíz y abre `http://localhost:8080/`. El servidor es solo una herramienta opcional de desarrollo. La aplicación publicada sirve archivos estáticos y no instala dependencias de ejecución.

## Detección y almacenamiento

- El navegador proporciona un flujo temporal de video para la vista previa y el análisis. SmartCapture analiza la región a la resolución disponible aproximadamente cuatro veces por segundo y guarda únicamente imágenes.
- La detección combina una comparación global con pruebas de contraste en regiones vecinas de 16 × 16 píxeles. Así puede distinguir un comando o diagrama localizado aunque casi toda la pantalla siga igual. La sensibilidad ajusta el contraste y la cantidad de píxeles necesarios. La captura manual omite estos umbrales y la espera.
- La captura pide excluir el cursor cuando el navegador lo permite. El análisis filtra los movimientos de cursor reconocibles, el desplazamiento de una barra con forma y pista identificables en el borde y algunos efectos hover que solo cambian un fondo uniforme sin alterar su texto. Si el cambio es ambiguo, la detección favorece conservar la captura.
- Un hash evita duplicados exactos en toda la galería, incluida la captura manual. Para la captura automática, el análisis usa un resumen de color para descartar candidatos diferentes y compara hasta 16 candidatos recientes a resolución original, uno por vez. La captura manual permite conservar variantes visualmente similares.
- Cuando se identifica un desplazamiento vertical, SmartCapture guarda vistas intermedias para conservar al menos un 30 % de superposición entre los puntos que puede seguir. Una vista desplazada solo se omite por falta de contenido nuevo si muestra una franja uniforme y los píxeles de la parte común coinciden dentro de la tolerancia. Los saltos muy rápidos, cabeceras fijas grandes o desplazamientos en paneles con poco contraste pueden impedir esa alineación.
- El recorte opcional comprueba cada lado por separado y solo quita columnas uniformes de un color neutro. Deja una reserva de ocho píxeles antes del contenido detectado. Los márgenes con sombras, gradientes, barras u otros elementos pueden quedar intactos.
- IndexedDB guarda las capturas, los archivos importados, las miniaturas y el orden. Los datos pertenecen al perfil y origen actuales. Una recarga conserva la galería y termina la sesión de pantalla. El modo privado, el borrado de datos del sitio o las políticas y cuotas del navegador pueden limitar la persistencia. Exporta antes de depender de esos datos como respaldo.
- Al actualizar desde una versión anterior, IndexedDB migra la galería y la papelera a «General». SmartCapture recuerda el último álbum utilizado al recargar.
- La papelera se conserva al recargar. La restauración usa los identificadores de las imágenes vecinas y, si desaparecieron ambas referencias, la posición original más cercana. PDF y ZIP incluyen solo la galería activa. El espacio de una imagen eliminada se libera al borrarla definitivamente.
- Para exportar se procesa una imagen original a la vez. Los archivos resultantes se construyen en el navegador y su tamaño puede afectar a dispositivos con poca memoria. El ZIP clásico admite hasta 65 535 entradas y menos de 4 GiB. Para sesiones grandes, exporta en tandas.

## Limitaciones del navegador

- El permiso de captura requiere una acción del usuario y se vuelve a solicitar para cada fuente. El navegador decide qué fuentes ofrece, qué resolución entrega y cuándo suspende o finaliza el flujo. Un sitio protegido puede aparecer en negro. La aplicación usa solo los píxeles autorizados por el selector del navegador.
- Si Chromium ofrece acceso directo a los fotogramas, el análisis puede avanzar aunque la vista previa deje de repintarse. Un temporizador en un Web Worker mantiene el muestreo de vistas estáticas y respalda la captura mediante la vista previa. Chromium aún puede espaciar la ejecución, congelar pestañas ocultas o reducir los fotogramas. Minimizar la fuente, bloquear el equipo o dejarlo en suspensión también puede interrumpir la entrega. Los cambios entre muestras y las vistas breves pueden pasar inadvertidos. Si aparecen omisiones, mantén SmartCapture visible cuando sea posible o usa la captura manual.
- La máxima resolución del PNG es la del flujo que Chrome o Brave entrega para la fuente y el recorte elegidos. El tamaño de la vista previa no altera esa resolución.

## Verificación

Ejecuta `node --test tests/detection.mjs tests/analysis.mjs tests/trash.mjs` para las pruebas de detección, recorte, desplazamiento y restauración. Con Node.js 22 o posterior y Chromium instalado, ejecuta `node tests/interactive.mjs` para comprobar la captura, la galería y la papelera. Añade `--albums` para verificar los álbumes y la migración de una base de datos anterior, o `--selection` para probar la selección múltiple. Usa `--preview` para tomar los fotogramas de la vista previa. Puedes indicar el ejecutable mediante la variable `CHROMIUM`.

- En Chromium 156 para Linux, la prueba interactiva compartió una pestaña real con `getDisplayMedia` y mantuvo SmartCapture oculta. Verificó cambios de texto y diagrama, cursor, hover, duplicados de vistas anteriores, solapamiento al desplazar y resolución del PNG. Pasó con lectura directa de fotogramas y con la ruta de vista previa. También comprobó el recorte, la navegación del visor y el borrado confirmado con persistencia al recargar.
- Un flujo de video sintético en Chromium permitió comprobar el recorte, la espera de estabilidad, cambios de pocos píxeles, duplicados, pausa, captura manual, reanudación, finalización, reordenación, ampliación, eliminación y persistencia después de recargar. También se comprobaron los umbrales RGB y el ajuste de la espera en Node.js.
- La prueba actual compara el PNG recortado con su región en la captura sin recortar, comprueba que el ZIP incluye sus bytes exactos y compara el RGB del PDF píxel a píxel. Una prueba de regresión también validó el orden de exportación.

Quedan por comprobar en Windows 11 el selector de pestaña, ventana y pantalla en Chrome y Brave y las sesiones largas con la aplicación oculta. La verificación se hizo con contenido de prueba.

Para la revisión en Windows 11, prueba las tres fuentes, selecciona una región con texto pequeño y cambia un carácter. Comprueba el contador, intercambia dos imágenes y revisa el orden en PDF y ZIP. Deja la aplicación en segundo plano varios minutos y vuelve a cambiar de lección para comprobar cómo se comporta con la configuración de ahorro de recursos de ese navegador.
