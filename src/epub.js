import "../lib/foliate-js/view.js";

const fileInput = document.getElementById("epub-file");
const viewer = document.getElementById("epub-viewer");

fileInput.addEventListener("change", async () => {
    const file = fileInput.files[0];

    if (!file) return;

    const view = document.createElement("foliate-view");

    viewer.appendChild(view);

    view.addEventListener("load", ({ detail }) => {
        const { doc, index } = detail;

        console.log("Loaded section:", index);
        console.log("Document:", doc);
        console.log("Text:", doc.body.innerText);
    });

    await view.open(file);
});