/*
 * AUD-009 / AUD-010: multi-document writes are actually atomic on the same
 * topology used in production. These tests deliberately fault after an earlier
 * write and verify that MongoDB rolls the whole unit back.
 */
const os = require("os");
const fs = require("fs");
const path = require("path");

process.env.NODE_ENV = "test";
process.env.JWT_SECRET ||= "transaction-boundary-secret";
process.env.CRYPTR_KEY ||= "transaction-boundary-cryptr";
process.env.EXAM_PDF_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "examopia-tx-private-")
);
process.env.PDF_STAGING_DIR = fs.mkdtempSync(
  path.join(os.tmpdir(), "examopia-tx-staging-")
);

const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");
const User = require("../models/userModel");
const Class = require("../models/classModel");
const Exam = require("../models/examModel");
const Question = require("../models/questionModel");
const PDF = require("../models/pdfModel");
const Enrollment = require("../models/enrollmentModel");
const {
  addQuestion,
  editExam,
} = require("../controllers/quizController");
const {
  archiveUsers,
  archiveClass,
} = require("../services/entityLifecycle");
const { pathForKey } = require("../helper/examPdfStorage");

let passed = 0;
let failed = 0;
const ok = (name, condition) => {
  if (condition) {
    passed += 1;
    console.log("  ✓", name);
  } else {
    failed += 1;
    console.log("  ✗ FAIL:", name);
  }
};

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function expectThrow(work) {
  try {
    await work();
    return false;
  } catch {
    return true;
  }
}

async function main() {
  const repl = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  await mongoose.connect(repl.getUri());

  try {
    const owner = await User.create({
      name: "Owner",
      email: "tx-owner@example.com",
      password: "Password1",
      role: "teacher",
      teacherApproval: "approved",
      isVerified: true,
    });
    const klass = await Class.create({
      name: "11A",
      owner: owner._id,
      joinCode: "TXBOUND1",
      requireCode: true,
    });
    const question = await Question.create({
      exam: new mongoose.Types.ObjectId(),
      correctAnswers: [{ type: "Cm", answer: "a" }],
    });
    const exam = await Exam.create({
      _id: question.exam,
      name: "Before",
      owner: owner._id,
      class: klass._id,
      duration: 600,
      totalMarks: 100,
      passingMarks: 50,
      price: 0,
      questions: question._id,
    });

    // addQuestion first updates Question, then links/settings on Exam. Force the
    // second write to fail and prove the first update was rolled back.
    const originalExamUpdateOne = Exam.updateOne;
    Exam.updateOne = async () => {
      throw new Error("fault_after_question_write");
    };
    const addFailed = await expectThrow(() =>
      addQuestion(
        {
          params: { examId: String(exam._id) },
          body: {
            correctAnswers: [{ type: "Cm", answer: "b" }],
            questionsPerPage: 7,
          },
          user: owner,
        },
        response()
      )
    );
    Exam.updateOne = originalExamUpdateOne;
    const questionAfter = await Question.findById(question._id).lean();
    const examAfter = await Exam.findById(exam._id).lean();
    ok("addQuestion injected fault reaches the caller", addFailed);
    ok(
      "answer-key update rolled back",
      questionAfter.correctAnswers[0].answer === "a"
    );
    ok(
      "exam draft settings rolled back",
      Number(examAfter.questionsPerPage || 0) === 0
    );

    // editExam must not commit scalar fields if the new PDF cannot finish its
    // attaching transition. The PDF model write is the final transactional step.
    const oldKey = "1".repeat(64);
    const newKey = "2".repeat(64);
    fs.writeFileSync(pathForKey(oldKey), Buffer.from("%PDF-1.7\nold\n%%EOF\n"));
    fs.writeFileSync(pathForKey(newKey), Buffer.from("%PDF-1.7\nnew\n%%EOF\n"));
    const oldPdf = await PDF.create({
      key: oldKey,
      owner: owner._id,
      examId: exam._id,
      state: "attached",
      size: 20,
    });
    await Exam.updateOne({ _id: exam._id }, { $set: { pdf: oldPdf._id } });
    const staged = await PDF.create({
      key: newKey,
      owner: owner._id,
      state: "staged",
      size: 20,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const originalPdfUpdateOne = PDF.updateOne;
    PDF.updateOne = async function faultAttach(filter, update, options) {
      if (update?.$set?.state === "attached") {
        throw new Error("fault_before_pdf_attach");
      }
      return originalPdfUpdateOne.call(this, filter, update, options);
    };
    const editFailed = await expectThrow(() =>
      editExam(
        {
          params: { examId: String(exam._id) },
          body: {
            name: "After",
            startDate: new Date(Date.now() + 60_000).toISOString(),
            endDate: new Date(Date.now() + 120_000).toISOString(),
            duration: 900,
            totalMarks: 100,
            passingMarks: 50,
            maxTry: 2,
            pdfPath: String(staged._id),
          },
          user: owner,
        },
        response()
      )
    );
    PDF.updateOne = originalPdfUpdateOne;
    const editAfter = await Exam.findById(exam._id).lean();
    ok("editExam injected attach fault reaches the caller", editFailed);
    ok("editExam scalar fields rolled back", editAfter.name === "Before");
    ok(
      "editExam PDF reference rolled back",
      String(editAfter.pdf) === String(oldPdf._id)
    );
    ok(
      "failed replacement upload was reclaimed",
      !(await PDF.findById(staged._id)) && !fs.existsSync(pathForKey(newKey))
    );

    // Lifecycle service: mutate Class, then fail the dependent Exam mutation.
    const originalExamUpdateMany = Exam.updateMany;
    Exam.updateMany = async () => {
      throw new Error("fault_after_class_archive");
    };
    const classFailed = await expectThrow(() =>
      archiveClass(klass._id, owner._id)
    );
    Exam.updateMany = originalExamUpdateMany;
    ok("class archive injected fault reaches the caller", classFailed);
    ok(
      "class archive rolled back",
      (await Class.findById(klass._id)).deletedAt === null
    );

    // Account lifecycle: mutate User, then fail Enrollment cleanup.
    const student = await User.create({
      name: "Student",
      email: "tx-student@example.com",
      password: "Password1",
      role: "student",
      isVerified: true,
    });
    const originalEnrollmentDelete = Enrollment.deleteMany;
    Enrollment.deleteMany = async () => {
      throw new Error("fault_after_user_archive");
    };
    const userFailed = await expectThrow(() =>
      archiveUsers([student._id], owner._id)
    );
    Enrollment.deleteMany = originalEnrollmentDelete;
    const studentAfter = await User.findById(student._id).lean();
    ok("user archive injected fault reaches the caller", userFailed);
    ok(
      "user anonymization and suspension rolled back",
      studentAfter.email === "tx-student@example.com" &&
        studentAfter.role === "student" &&
        studentAfter.deletedAt === null
    );
  } finally {
    await mongoose.disconnect();
    await repl.stop();
    fs.rmSync(process.env.EXAM_PDF_DIR, { recursive: true, force: true });
    fs.rmSync(process.env.PDF_STAGING_DIR, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
