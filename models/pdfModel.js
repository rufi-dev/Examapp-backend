const mongoose = require('mongoose');
const { Schema } = mongoose;

const pdfSchema = Schema({
    path: {
        type: String,
        required: true,
    }
});

const PdfModel = mongoose.model('PDF', pdfSchema);

module.exports = PdfModel;
