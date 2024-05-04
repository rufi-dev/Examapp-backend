const mongoose = require('mongoose');
const { Schema } = mongoose;

const pdfSchema = Schema({
    data: {
        type: Buffer,
        required: true,
    },
    path: {
        type: String,
        required: true,
    },
    contentType: {
        type: String,
        required: true,
    },
});

const PdfModel = mongoose.model('PDF', pdfSchema);

module.exports = PdfModel;
