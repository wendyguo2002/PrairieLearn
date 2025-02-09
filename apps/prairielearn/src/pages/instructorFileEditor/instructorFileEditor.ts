import * as path from 'path';

import * as modelist from 'ace-code/src/ext/modelist.js';
import { AnsiUp } from 'ansi_up';
import sha256 from 'crypto-js/sha256.js';
import debugfn from 'debug';
import * as express from 'express';
import asyncHandler from 'express-async-handler';
import fs from 'fs-extra';
import { isBinaryFile } from 'isbinaryfile';

import * as error from '@prairielearn/error';
import { logger } from '@prairielearn/logger';
import * as sqldb from '@prairielearn/postgres';

import { b64EncodeUnicode, b64DecodeUnicode } from '../../lib/base64-util.js';
import { getCourseOwners } from '../../lib/course.js';
import { getErrorsAndWarningsForFilePath } from '../../lib/editorUtil.js';
import { FileModifyEditor } from '../../lib/editors.js';
import { deleteFile, getFile, uploadFile } from '../../lib/file-store.js';
import { idsEqual } from '../../lib/id.js';
import { getPaths } from '../../lib/instructorFiles.js';
import {
  getJobSequenceWithFormattedOutput,
  type JobSequenceWithFormattedOutput,
} from '../../lib/server-jobs.js';

import { InstructorFileEditor } from './instructorFileEditor.html.js';

const router = express.Router();
const sql = sqldb.loadSqlEquiv(import.meta.url);
const debug = debugfn('prairielearn:instructorFileEditor');

interface FileEdit {
  userID: string;
  authnUserId: string;
  courseID: string;
  coursePath: string;
  dirName: string;
  fileName: string;
  fileNameForDisplay: string;
  aceMode: string;
  jobSequence?: JobSequenceWithFormattedOutput;
  diskContents?: string;
  diskHash?: string;
  jobSequenceId?: string;
  sync_errors?: string | null;
  sync_errors_ansified?: string | null;
  sync_warnings?: string | null;
  sync_warnings_ansified?: string | null;
  alertChoice?: boolean;
  didSave?: boolean;
  didSync?: boolean;
  fileID?: string;
  editID?: string;
  editContents?: string;
  editHash?: string;
  origHash?: string;
  alertResults?: boolean;
  hasSameHash?: boolean;
}

router.get(
  '/*',
  asyncHandler(async (req, res) => {
    if (!res.locals.authz_data.has_course_permission_edit) {
      // Access denied, but instead of sending them to an error page, we'll show
      // them an explanatory message and prompt them to get edit permissions.
      res.locals.course_owners = await getCourseOwners(res.locals.course.id);
      res.status(403).send(InstructorFileEditor({ resLocals: res.locals }));
      return;
    }

    // Do not allow users to edit the exampleCourse
    if (res.locals.course.example_course) {
      res.status(403).send(InstructorFileEditor({ resLocals: res.locals }));
      return;
    }

    // Do not allow users to edit files in bad locations (e.g., outside the
    // current course, outside the current course instance, etc.). Do this by
    // wrapping everything in getPaths, which throws an error on a bad path.
    const paths = getPaths(req.params[0], res.locals);

    // We could also check if the file exists, if the file actually is a
    // file and not a directory, if the file is non-binary, etc., and try
    // to give a graceful error message on the edit page rather than send
    // the user to an error page.
    //
    // We won't do that, on the assumption that most users get to an edit
    // page through our UI, which already tries to prevent letting users
    // go where they should not.

    const fullPath = paths.workingPath;
    const relPath = paths.workingPathRelativeToCourse;
    const fileEdit: FileEdit = {
      userID: res.locals.user.user_id,
      authnUserId: res.locals.authn_user.user_id,
      courseID: res.locals.course.id,
      coursePath: paths.coursePath,
      dirName: path.dirname(relPath),
      fileName: path.basename(relPath),
      fileNameForDisplay: path.normalize(relPath),
      aceMode: modelist.getModeForPath(relPath).mode,
      alertChoice: false,
      didSave: false,
      didSync: false,
    };

    debug('Read from db');
    await readDraftEdit(fileEdit);

    debug('Read from disk');
    const contents = await fs.readFile(fullPath);
    fileEdit.diskContents = b64EncodeUnicode(contents.toString('utf8'));
    fileEdit.diskHash = getHash(fileEdit.diskContents);

    const binary = await isBinaryFile(contents);
    debug(`isBinaryFile: ${binary}`);
    if (binary) {
      debug('found a binary file');
      throw new Error('Cannot edit binary file');
    } else {
      debug('found a text file');
    }

    if (fileEdit.jobSequenceId != null) {
      debug('Read job sequence');
      fileEdit.jobSequence = await getJobSequenceWithFormattedOutput(
        fileEdit.jobSequenceId,
        res.locals.course.id,
      );
    }

    const data = await getErrorsAndWarningsForFilePath(res.locals.course.id, relPath);
    const ansiUp = new AnsiUp();
    fileEdit.sync_errors = data.errors;
    fileEdit.sync_errors_ansified =
      fileEdit.sync_errors && ansiUp.ansi_to_html(fileEdit.sync_errors);
    fileEdit.sync_warnings = data.warnings;
    fileEdit.sync_warnings_ansified =
      fileEdit.sync_warnings && ansiUp.ansi_to_html(fileEdit.sync_warnings);

    if (fileEdit && fileEdit.jobSequence?.status === 'Running') {
      // Because of the redirect, if the job sequence ends up failing to save,
      // then the corresponding draft will be lost (all drafts are soft-deleted
      // from the database on readDraftEdit).
      debug('Job sequence is still running - redirect to status page');
      res.redirect(`${res.locals.urlPrefix}/jobSequence/${fileEdit.jobSequenceId}`);
      return;
    }

    if (fileEdit.jobSequence) {
      // No draft is older than 24 hours, so it is safe to assume that no
      // job sequence is legacy... but, just in case, we will check and log
      // a warning if we find one. We will treat the corresponding draft as
      // if it was neither saved nor synced.
      if (fileEdit.jobSequence.legacy) {
        debug('Found a legacy job sequence');
        logger.warn(
          `Found a legacy job sequence (id=${fileEdit.jobSequenceId}) ` +
            `in a file edit (id=${fileEdit.editID})`,
        );
      } else {
        const job = fileEdit.jobSequence.jobs[0];

        debug('Found a job sequence');
        debug(` saveAttempted=${job.data.saveAttempted}`);
        debug(` saveSucceeded=${job.data.saveSucceeded}`);
        debug(` syncAttempted=${job.data.syncAttempted}`);
        debug(` syncSucceeded=${job.data.syncSucceeded}`);

        // We check for the presence of a `saveSucceeded` key to know if
        // the edit was saved (i.e., written to disk in the case of no git,
        // or written to disk and then pushed in the case of git). If this
        // key exists, its value will be true.
        if (job.data.saveSucceeded) {
          fileEdit.didSave = true;

          // We check for the presence of a `syncSucceeded` key to know
          // if the sync was successful. If this key exists, its value will
          // be true. Note that the cause of sync failure could be a file
          // other than the one being edited.
          //
          // By "the sync" we mean "the sync after a successfully saved
          // edit." Remember that, if using git, we pull before we push.
          // So, if we error on save, then we still try to sync whatever
          // was pulled from the remote repository, even though changes
          // made by the edit will have been discarded. We ignore this
          // in the UI for now.
          if (job.data.syncSucceeded) {
            fileEdit.didSync = true;
          }
        }
      }
    }

    if (fileEdit.editID) {
      // There is a recently saved draft ...
      fileEdit.alertResults = true;
      if (!fileEdit.didSave && fileEdit.editHash !== fileEdit.diskHash) {
        // ...that was not written to disk and that differs from what is on disk.
        fileEdit.alertChoice = true;
        fileEdit.hasSameHash = fileEdit.origHash === fileEdit.diskHash;
      }
    }

    if (!fileEdit.alertChoice) {
      fileEdit.editContents = fileEdit.diskContents;
      fileEdit.origHash = fileEdit.diskHash;
    }

    res.locals.fileEdit = fileEdit;
    res.locals.fileEdit.paths = paths;
    res.send(InstructorFileEditor({ resLocals: res.locals }));
  }),
);

router.post(
  '/*',
  asyncHandler(async (req, res) => {
    debug('POST /');
    if (!res.locals.authz_data.has_course_permission_edit) {
      throw new error.HttpStatusError(403, 'Access denied (must be a course Editor)');
    }

    const paths = getPaths(req.params[0], res.locals);

    const container = {
      rootPath: paths.rootPath,
      invalidRootPaths: paths.invalidRootPaths,
    };

    // NOTE: All actions are meant to do things to *files* and not to directories
    // (or anything else). However, nowhere do we check that it is actually being
    // applied to a file and not to a directory.

    if (req.body.__action === 'save_and_sync') {
      debug('Save and sync');

      debug('Write draft file edit to db and to file store');
      const editID = await writeDraftEdit({
        userID: res.locals.user.user_id,
        authnUserID: res.locals.authn_user.user_id,
        courseID: res.locals.course.id,
        dirName: paths.workingDirectory,
        fileName: paths.workingFilename,
        origHash: req.body.file_edit_orig_hash,
        coursePath: res.locals.course.path,
        uid: res.locals.user.uid,
        user_name: res.locals.user.name,
        editContents: req.body.file_edit_contents,
      });

      const editor = new FileModifyEditor({
        locals: res.locals,
        container,
        filePath: paths.workingPath,
        editContents: req.body.file_edit_contents,
        origHash: req.body.file_edit_orig_hash,
      });

      const serverJob = await editor.prepareServerJob();
      await updateJobSequenceId(editID, serverJob.jobSequenceId);

      try {
        await editor.executeWithServerJob(serverJob);
      } catch {
        // We're deliberately choosing to ignore errors here. If there was an
        // error, we'll still redirect the user back to the same page, which will
        // allow them to handle the error.
      }

      res.redirect(req.originalUrl);
    } else {
      throw new error.HttpStatusError(400, `unknown __action: ${req.body.__action}`);
    }
  }),
);

function getHash(contents: string) {
  return sha256(contents).toString();
}

async function readDraftEdit(fileEdit: FileEdit) {
  debug('Looking for previously saved drafts');
  const draftResult = await sqldb.queryAsync(sql.select_file_edit, {
    user_id: fileEdit.userID,
    course_id: fileEdit.courseID,
    dir_name: fileEdit.dirName,
    file_name: fileEdit.fileName,
  });
  if (draftResult.rows.length > 0) {
    debug(
      `Found ${draftResult.rows.length} saved drafts, the first of which has id ${draftResult.rows[0].id}`,
    );
    if (draftResult.rows[0].age < 24) {
      fileEdit.editID = draftResult.rows[0].id;
      fileEdit.origHash = draftResult.rows[0].orig_hash;
      fileEdit.jobSequenceId = draftResult.rows[0].job_sequence_id;
      fileEdit.fileID = draftResult.rows[0].file_id;
    } else {
      debug(`Rejected this draft, which had age ${draftResult.rows[0].age} >= 24 hours`);
    }
  } else {
    debug('Found no saved drafts');
  }

  // We are choosing to soft-delete all drafts *before* reading the
  // contents of whatever draft we found, because we don't want to get
  // in a situation where the user is trapped with an unreadable draft.
  // We accept the possibility that a draft will occasionally be lost.
  const result = await sqldb.queryAsync(sql.soft_delete_file_edit, {
    user_id: fileEdit.userID,
    course_id: fileEdit.courseID,
    dir_name: fileEdit.dirName,
    file_name: fileEdit.fileName,
  });
  debug(`Deleted ${result.rowCount} previously saved drafts`);
  for (const row of result.rows) {
    if (fileEdit.fileID != null && idsEqual(row.file_id, fileEdit.fileID)) {
      debug(`Defer removal of file_id=${row.file_id} from file store until after reading contents`);
    } else {
      debug(`Remove file_id=${row.file_id} from file store`);
      await deleteFile(row.file_id, fileEdit.userID);
    }
  }

  if (fileEdit.editID && fileEdit.fileID) {
    debug('Read contents of file edit');
    const result = await getFile(fileEdit.fileID);
    const contents = b64EncodeUnicode(result.contents.toString('utf8'));
    fileEdit.editContents = contents;
    fileEdit.editHash = getHash(fileEdit.editContents);

    debug(`Remove file_id=${fileEdit.fileID} from file store`);
    await deleteFile(fileEdit.fileID, fileEdit.userID);
  }
}

async function updateJobSequenceId(edit_id: string, job_sequence_id: string) {
  await sqldb.queryAsync(sql.update_job_sequence_id, {
    id: edit_id,
    job_sequence_id,
  });
  debug(`Update file edit id=${edit_id}: job_sequence_id=${job_sequence_id}`);
}

async function writeDraftEdit(fileEdit: {
  userID: string;
  authnUserID: string;
  courseID: string;
  dirName: string;
  fileName: string;
  origHash: string;
  coursePath: string;
  uid: string;
  user_name: string;
  editContents: string;
}) {
  const deletedFileEdits = await sqldb.queryAsync(sql.soft_delete_file_edit, {
    user_id: fileEdit.userID,
    course_id: fileEdit.courseID,
    dir_name: fileEdit.dirName,
    file_name: fileEdit.fileName,
  });
  debug(`Deleted ${deletedFileEdits.rowCount} previously saved drafts`);
  for (const row of deletedFileEdits.rows) {
    debug(`Remove file_id=${row.file_id} from file store`);
    await deleteFile(row.file_id, fileEdit.userID);
  }

  debug('Write contents to file store');
  const fileID = await uploadFile({
    display_filename: fileEdit.fileName,
    contents: Buffer.from(b64DecodeUnicode(fileEdit.editContents), 'utf8'),
    type: 'instructor_file_edit',
    assessment_id: null,
    assessment_instance_id: null,
    instance_question_id: null,
    user_id: fileEdit.userID,
    authn_user_id: fileEdit.authnUserID,
  });
  debug(`Wrote file_id=${fileID} to file store`);

  const params = {
    user_id: fileEdit.userID,
    course_id: fileEdit.courseID,
    dir_name: fileEdit.dirName,
    file_name: fileEdit.fileName,
    orig_hash: fileEdit.origHash,
    file_id: fileID,
  };
  debug(
    `Insert file edit into db: ${params.user_id}, ${params.course_id}, ${params.dir_name}, ${params.file_name}`,
  );
  const result = await sqldb.queryOneRowAsync(sql.insert_file_edit, params);
  const editID = result.rows[0].id;
  debug(`Created file edit in database with id ${editID}`);
  return editID;
}

export default router;
