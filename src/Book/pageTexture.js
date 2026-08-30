import * as THREE from 'three';

/**
 * Creates a plane mesh whose material is a canvas texture. `updateFromCanvas`
 * blits a source canvas (e.g. a screenshot of the rendered epub page) onto
 * that texture at its native resolution — the canvas is resized to match
 * the source exactly (no stretching) and the plane's height is rescaled to
 * match its aspect ratio, so the page is never cropped or distorted; `width`
 * is the plane's fixed physical width in meters, height follows the content.
 */
export function createPageMesh({ width = 0.2 } = {}) {
    const canvas = document.createElement('canvas');
    // A blank canvas defaults to transparent, which a non-transparent
    // material renders as solid black — indistinguishable from empty space
    // against the scene background. Filling it white keeps the mesh visibly
    // "there" as a blank page before the first real capture lands.
    canvas.width = 3;
    canvas.height = 4;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;

    const geometry = new THREE.PlaneGeometry(1, 1);
    const material = new THREE.MeshBasicMaterial({ map: texture, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.scale.set(width, width * (canvas.height / canvas.width), 1);

    function updateFromCanvas(sourceCanvas) {
        canvas.width = sourceCanvas.width;
        canvas.height = sourceCanvas.height;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(sourceCanvas, 0, 0);
        texture.needsUpdate = true;

        mesh.scale.y = width * (sourceCanvas.height / sourceCanvas.width);
    }

    return { mesh, texture, updateFromCanvas };
}
