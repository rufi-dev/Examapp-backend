const nodemailer = require('nodemailer');
const hbs = require('nodemailer-express-handlebars');
const path = require('path');

const sendEmail = async (subject, send_to, sent_from, reply_to, template, name, link) => {
    const port = Number(process.env.EMAIL_PORT) || 587;

    // Create Email Transporter
    const transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port,
        secure: port === 465, // 465 = implicit TLS, 587 = STARTTLS
        auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASS
        },
        tls: {
            rejectUnauthorized: false
        }
    })

    const handlebarOptions = {
        viewEngine: {
            extName: ".handlebars",
            partialsDir: path.resolve("./views"),
            defaultLayout: false
        },
        viewPath: path.resolve("./views"),
        extName: ".handlebars",
    }

    transporter.use("compile", hbs(handlebarOptions))

    //Options for sending email
    const options = {
        from: { name: process.env.EMAIL_FROM_NAME || "Sınaq Riyaziyyat", address: sent_from },
        to: send_to,
        replyTo: reply_to,
        subject: subject,
        template: template,
        context: {
            name,
            link
        }
    }

    // Await the send so callers' try/catch can actually react to SMTP errors.
    // (The old callback form resolved before the send completed and only
    // console.log'd failures, so a broken transporter looked like a success.)
    const info = await transporter.sendMail(options)
    return info
}

module.exports = { sendEmail }
