const asyncHandler = require("express-async-handler");
const Exam = require("../models/examModel");
const PDF = require("../models/pdfModel");
const Tag = require("../models/tagModel");
const Class = require("../models/classModel");
const Question = require("../models/questionModel");
const Result = require("../models/resultModel");
const User = require("../models/userModel");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");

// Add Tag
const addTag = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) {
    res.status(500);
    throw new Error("Name field required");
  }

  const exists = await Tag.findOne({ name });

  if (exists) {
    res.status(500);
    throw new Error("Tag with this name already exists");
  }

  await Tag.create({ name });
  res.status(200).json({ name });
});

// Add Class
const addClass = asyncHandler(async (req, res) => {
  const { level } = req.body;
  const { tagId } = req.params;

  try {
    if (!level) {
      res.status(400).json({ error: "Level field required" });
      return;
    }

    const tag = await Tag.findById(tagId);

    if (!tag) {
      res.status(404).json({ error: "No Tag found" });
      return;
    }

    const newClass = await Class.create({ level, tag: tagId });
    tag.classes.push(newClass._id);
    await tag.save();

    res.status(201).json({ message: "Class has been saved", newClass });
  } catch (e) {
    console.log(e);
  }
});

const getClass = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const _class = await Class.findById(id);

  if (!_class) {
    res.status(404);
    throw new Error("No class found");
  }

  res.status(200).json(_class);
});

// Get Tags
const getTags = asyncHandler(async (req, res) => {
  const tags = await Tag.find().populate("exams");

  if (!tags) {
    res.status(404);
    throw new Error("No tags found");
  }

  res.status(200).json(tags);
});

// Get Tags
const getTag = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const tag = await Tag.findById(id);

  if (!tag) {
    res.status(404);
    throw new Error("No tag found");
  }

  res.status(200).json(tag);
});

const addExam = asyncHandler(async (req, res) => {
  const {
    name,
    duration,
    price,
    deadline,
    videoLink,
    totalMarks,
    passingMarks,
  } = req.body;
  const { classId } = req.params;
  console.log({
    name,
    duration,
    price,
    videoLink,
    deadline,
    totalMarks,
    passingMarks,
    pdf: req.file,
  });

  // Check if all required fields are present
  if (!name || !duration || !totalMarks || !passingMarks || !req.file) {
    res
      .status(400)
      .json({ success: false, message: "All fields are required" });
    return;
  }

  try {
    // Create a PDF entry
    const pdf = new PDF({
      data: req.file.path,
      path: req.file.path,
      contentType: req.file.mimetype,
    });
    // Save the PDF entry to the database
    const savedPdf = await pdf.save();

    // Create an exam entry with the PDF ID

    const existingClass = await Class.findById(classId);
    if (!existingClass) {
      return res.status(404).json({ success: false, error: "Class not found" });
    }

    const newExam = new Exam({
      name,
      duration,
      price,
      deadline,
      totalMarks,
      passingMarks,
      videoLink,
      class: classId,
      pdf: savedPdf._id, // Assign the PDF ID to the exam's pdf field
    });

    // Save the exam entry
    await newExam.save();

    existingClass.exams.push(newExam._id);
    await existingClass.save();

    // Return success response
    res.status(201).json({ success: true, data: newExam });
  } catch (error) {
    console.error("Error saving PDF:", error);
    res.status(500).json({ success: false, error: "Failed to save PDF" });
  }
});

const getPdfByExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;

  if (!examId) {
    res.status(404);
    throw new Error("Exam is not defined!");
  }

  try {
    const exam = await Exam.findById(examId);

    if (!exam) {
      res.status(404);
      throw new Error("Exam not found!");
    }

    // Fetch the PDF associated with the exam
    const pdf = await PDF.findById(exam.pdf);

    if (!pdf) {
      res.status(500);
      throw new Error("PDF not found");
    }

    res.status(200).json(pdf);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const addExamToUser = asyncHandler(async (req, res) => {
  const { token } = req.query;

  if (!token) {
    res.status(500);
    throw new Error("Invalid Token");
  }

  try {
    const decodedToken = jwt.verify(token, process.env.JWT_SECRET);
    const { userId } = decodedToken;

    if (!userId) {
      res.status(404);
      throw new Error("User or Exam not found");
    }

    const { examId } = req.params;
    const user = await User.findById(req.user._id);

    if (!user) {
      res.status(404);
      throw new Error("User not found!");
    }
    if (!examId) {
      res.status(404);
      throw new Error("No Exam found");
    }

    const isExamExist = user.exams.includes(examId);

    const exam = await Exam.findById(examId);

    if (!exam) {
      res.status(404);
      throw new Error("No Exam found");
    }

    if (isExamExist) {
      res.status(500);
      throw new Error("Exam has already been added!");
    } else {
      user.exams.push(examId);
      await user.save();

      exam.users.push(user._id);
      await exam.save();

      res.status(200).json(exam);
    }
  } catch (error) {
    console.error("Invalid token:", error);
    res.status(401).json({ message: "Unauthorized" });
  }
});

const addExamToUserById = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { examId } = req.body;
  const user = await User.findById(userId);
  console.log(req.body);
  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }
  if (!examId) {
    res.status(404);
    throw new Error("Exam is not defined");
  }

  const isExamExist = user.exams.includes(examId);

  const exam = await Exam.findById(examId);

  if (!exam) {
    res.status(404);
    throw new Error("No Exam found");
  }

  if (isExamExist) {
    res.status(500);
    throw new Error("Exam has already been added!");
  } else {
    user.exams.push(examId);
    await user.save();

    exam.users.push(user._id);
    await exam.save();

    res.status(200).json({ message: "Exam successfully added" });
  }
});

const getExamsByClass = asyncHandler(async (req, res) => {
  const { classId } = req.params;
  if (!classId) {
    res.status(404);
    throw new Error("Tag is not defined");
  }

  const exists = await Class.findById(classId);

  if (!exists) {
    res.status(404);
    throw new Error("No Class Found");
  }

  const objectId = new mongoose.Types.ObjectId(classId);

  const exams = await Exam.find({ class: objectId });

  if (!exams) {
    res.status(500);
    throw new Error("No Exams Added yet");
  }

  res.status(200).json(exams);
});

const getClassesByTag = asyncHandler(async (req, res) => {
  const { tagId } = req.params;

  if (!tagId) {
    res.status(400).json({ error: "Tag ID is required" });
    return;
  }

  // Ensure the provided tagId is a valid ObjectId
  if (!mongoose.Types.ObjectId.isValid(tagId)) {
    res.status(400).json({ error: "Invalid tag ID" });
    return;
  }

  try {
    const classes = await Class.find({ tag: tagId });

    if (classes.length === 0) {
      res.status(404).json({ message: "No classes found for this tag" });
      return;
    }

    res.status(200).json(classes);
  } catch (error) {
    console.error("Error fetching classes by tag:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

const getExams = asyncHandler(async (req, res) => {
  const exams = await Exam.find({});

  if (!exams) {
    res.status(500);
    throw new Error("No Exams Added yet");
  }

  res.status(200).json(exams);
});

const getExam = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const exam = await Exam.findById(id);

  if (!exam) {
    res.status(404);
    throw new Error("No exams found");
  }

  res.status(200).json(exam);
});

const addQuestion = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const { correctAnswers } = req.body;

  if (!correctAnswers || !examId) {
    res.status(400).json({ message: "All fields are required" });
    return;
  }

  // Check if answers already exist for the specified exam
  const exam = await Exam.findById(examId);
  if (!exam) {
    res.status(404).json({ message: "Exam not found" });
    return;
  }

  if (exam.questions.length > 0) {
    res.status(404);
    throw new Error("Bu Imtahanda Suallar artıq mövcüddur");
  }
  const convertedExamId = new mongoose.Types.ObjectId(examId);
  const newQuestion = await Question.create({
    correctAnswers,
    exam: convertedExamId,
  });

  exam.questions.push(newQuestion._id);
  await exam.save().then(() => {
    res
      .status(200)
      .json({ message: "Answers added successfully", newQuestion });
  });
});

const getExamTagandClass = asyncHandler(async (req, res) => {
  const { examId } = req.params;

  const exam = await Exam.findById(examId);
  if (!exam) {
    res.status(404).json({ message: "Exam not found" });
    return;
  }

  const _class = await Class.findById(exam.class);
  if (!_class) {
    res.status(404).json({ message: "Sinif tapilmadi" });
    return;
  }

  const tag = await Tag.findById(_class.tag);
  if (!tag) {
    res.status(404).json({ message: "Qrup tapilmadi" });
    return;
  }
  res.status(200).json({ tag, _class });
});

const addResult = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);
  const {
    attempts,
    earnPoints,
    selectedAnswers,
    correctAnswers,
    correctAnswersByType,
  } = req.body;
  const { examId } = req.params;

  try {
    if (!user) {
      res.status(404);
      throw new Error("User not found!");
    }

    if (!examId) {
      res.status(404);
      throw new Error("No Exam found");
    }

    const newResult = await Result.create({
      userId: user._id,
      examId,
      attempts,
      earnPoints,
      selectedAnswers,
      correctAnswers,
      correctAnswersByType,
    });

    if (!newResult) {
      res.status(500);
      throw new Error("Result couldn't be saved");
    }

    const exam = await Exam.findById(examId);

    if (!exam) {
      res.status(404);
      throw new Error("No Exam found");
    }
    exam.results.push(newResult._id);
    await exam.save();

    user.results.push(newResult._id);
    await user.save();

    if (newResult) {
      res.status(200).json({ message: "Result has been saved" });
    } else {
      res.status(500);
      throw new Error("Result couldn't be saved");
    }
  } catch (error) {
    console.log(error);
  }
});

const addPhotoToResult = asyncHandler(async (req, res) => {
  const { resultId } = req.params;
  const { photo } = req.body;
  if (!resultId) {
    res.status(400)
    throw new Error("Nəticə id si lazım")
  }

  const result = await Result.findById(resultId);

  if (!result) {
    res.status(404)
    throw new Error("Nəticə tapılmadı")
  }

  result.photos.push(photo);

  await result.save();

  res.status(200).json(result);
});

const getResultsByUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id);

  if (!user) {
    res.status(404);
    throw new Error("User not found");
  }

  const results = await Result.find({ userId: user._id }).populate("examId");

  if (!results) {
    res.status(404);
    throw new Error("No results found");
  }

  res.status(200).json(results);
});

const getResultsByExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const exam = await Exam.findById(examId);

  if (!exam) {
    res.status(404);
    throw new Error("No Exam Found!");
  }

  const results = await Result.find({  examId })
    .populate("examId")
    .populate("userId");

  if (!results) {
    res.status(404);
    throw new Error("No results found!");
  }

  res.status(200).json(results);
});

const getResultsByUserByExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const exam = await Exam.findById(examId);

  if (!exam) {
    res.status(404);
    throw new Error("No Exam Found!");
  }
  const user = await User.findById(req.user._id);

  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }

  const results = await Result.find({ userId: user._id, examId })
    .populate("examId")
    .populate("userId");

  if (!results) {
    res.status(404);
    throw new Error("No results found!");
  }

  res.status(200).json(results);
});

const reviewByResult = asyncHandler(async (req, res) => {
  const { resultId } = req.params;

  const user = await User.findById(req.user._id);
  const result = await Result.findById(resultId).populate({
    path: "examId",
    populate: {
      path: "questions",
    },
  });
  if (!result) {
    res.status(404);
    throw new Error("No Result Found!");
  }
  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }
  res.status(200).json(result);
});

const editQuestion = asyncHandler(async (req, res) => {
  const { questionId } = req.params;
  const { name, correctOption, options } = req.body;

  const questionExists = await Question.findById(questionId);

  if (questionExists) {
    await Question.findByIdAndUpdate(questionId, {
      name,
      correctOption,
      options,
    });

    res.status(200).json({
      message: "Question updated successfully",
    });
  } else {
    res.status(404).json({
      error: "Question not found!",
    });
  }
});

const editExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const { name, price, duration, totalMarks, passingMarks, tag } = req.body;
  const examExists = await Exam.findById(examId);
  const tagId = new mongoose.Types.ObjectId(tag.id);
  if (examExists) {
    await Exam.findByIdAndUpdate(examId, {
      examId,
      name,
      price,
      duration,
      totalMarks,
      passingMarks,
      tag: tagId,
    });

    res.status(200).json({
      message: "Exam updated successfully",
    });
  } else {
    res.status(404);
    throw new Error("Exam not found!");
  }
});

const editTag = asyncHandler(async (req, res) => {
  const { tagId } = req.params;
  const { name } = req.body;
  const tagExists = await Tag.findById(tagId);
  if (tagExists) {
    await Tag.findByIdAndUpdate(tagId, { name });

    res.status(200).json({
      message: "Tag updated successfully",
    });
  } else {
    res.status(404);
    throw new Error("Tag not found!");
  }
});

const deleteQuestion = asyncHandler(async (req, res) => {
  const { questionId } = req.params;

  const question = await Question.findById(questionId);

  if (!question) {
    res.status(404);
    throw new Error("Question not found!");
  }
  const exam = await Exam.findOne({ questions: question._id });

  if (exam) {
    exam.questions.remove(question._id);
    await exam.save();
  } else {
    res.status(404);
    throw new Error("Exam not found!");
  }

  await question.deleteOne();
  res.status(200).json({ message: "Question deleted succesfully" });
});

const deleteAllQuestions = asyncHandler(async (req, res) => {
  await Question.deleteMany({});
  res.status(200).json({ message: "All questions deleted successfully" });
});

const deleteExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;

  const exam = await Exam.findById(examId);
  if (!exam) {
    res.status(404);
    throw new Error("Exam not found!");
  }
  const questions = await Question.find({ exam: exam._id });

  if (questions && questions.length > 0) {
    for (const question of questions) {
      await question.deleteOne();
    }
  }

  await exam.deleteOne();
  res.status(200).json({ message: "Exam deleted succesfully" });
});

const deleteMyExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;
  const user = await User.findById(req.user._id);

  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }

  const exam = await Exam.findById(examId);
  if (!exam) {
    res.status(404);
    throw new Error("Exam not found!");
  }

  user.exams.pull(examId);
  await user.save();

  exam.users.pull(user._id);
  await exam.save();

  res.status(200).json({ message: "My Exam deleted succesfully" });
});

const getQuestionsByExam = asyncHandler(async (req, res) => {
  const { examId } = req.params;

  if (!examId) {
    res.status(404);
    throw new Error("Exam is not defined!");
  }
  const exam = await Exam.findById(examId);

  if (!exam) {
    res.status(404);
    throw new Error("Exam not found!");
  }

  const questions = await Question.find({ exam: examId });

  if (!questions) {
    res.status(500);
    throw new Error("No Questions Added yet");
  }

  res.status(200).json(questions);
});

const getExamsByUser = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).populate("exams");

  if (!user) {
    res.status(404);
    throw new Error("User not found!");
  }

  if (user.exams.length > 0) {
    res.status(200).json(user.exams);
  } else {
    res.status(200).json([]);
  }
});

module.exports = {
  addExam,
  getExamsByClass,
  addTag,
  getTags,
  addQuestion,
  getQuestionsByExam,
  editQuestion,
  deleteQuestion,
  getExam,
  getTag,
  editExam,
  addClass,
  getClassesByTag,
  deleteExam,
  editTag,
  addPhotoToResult,
  addResult,
  getResultsByUser,
  getResultsByUserByExam,
  getClass,
  getClassesByTag,
  addExamToUser,
  getExamsByUser,
  getExams,
  reviewByResult,
  deleteMyExam,
  addExamToUserById,
  getPdfByExam,
  deleteAllQuestions,
  getExamTagandClass,
  getResultsByExam
};
