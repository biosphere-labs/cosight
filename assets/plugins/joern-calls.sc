import io.shiftleft.semanticcpg.language.*

@main def exec(inputPath: String, outFile: String) = {
  importCode(inputPath)
  val methods = cpg.method.filterNot(_.isExternal).take(200).map { m =>
    ujson.Obj(
      "id" -> m.fullName,
      "name" -> m.name,
      "file" -> m.filename,
      "line" -> m.lineNumber.getOrElse(1),
      "calls" -> ujson.Arr.from(m.call.callee.fullName.l)
    )
  }.l
  java.nio.file.Files.writeString(java.nio.file.Path.of(outFile), ujson.write(ujson.Arr.from(methods)))
}
