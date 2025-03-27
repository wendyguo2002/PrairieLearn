import { assert } from 'chai';
import type { CheerioAPI } from 'cheerio';
import { step } from 'mocha-steps';

import { queryRow } from '@prairielearn/postgres';

import { config } from '../lib/config.js';
import { AssessmentSchema, type Assessment, type Question } from '../lib/db-types.js';
import { features } from '../lib/features/index.js';
import {
  insertCourseInstancePermissions,
  insertCoursePermissionsByUserUid,
} from '../models/course-permissions.js';
import { updateCourseSharingName } from '../models/course.js';
import { selectQuestionByQid } from '../models/question.js';

import { fetchCheerio } from './helperClient.js';
import * as helperServer from './helperServer.js';
import { getConfiguredUser, getOrCreateUser, withUser, type AuthUser } from './utils/auth.js';

const siteUrl = 'http://localhost:' + config.serverPort;

const PUBLIC_USER: AuthUser = {
  name: 'Public User',
  uid: 'public-user@example.com',
  uin: 'public-user',
};

const OTHER_PUBLIC_USER: AuthUser = {
  name: 'Other Public User',
  uid: 'other-public-user@example.com',
  uin: 'other-public-user',
};

const INSTRUCTOR_USER: AuthUser = {
  name: 'Instructor User',
  uid: 'instructor@example.com',
  uin: 'instructor',
};

const COURSE_ASSISTANT_USER: AuthUser = {
  name: 'Course Assistant User',
  uid: 'course-assistant@example.com',
  uin: 'course-assistant',
};

const STUDENT_USER: AuthUser = {
  name: 'Student User',
  uid: 'student@example.com',
  uin: 'student',
};

const OTHER_STUDENT_USER: AuthUser = {
  name: 'Other Student User',
  uid: 'other-student@example.com',
  uin: 'other-student',
};

function getVariantId(cheerio: CheerioAPI): string {
  const variantId = cheerio('.question-container').attr('data-variant-id');
  assert(variantId);
  assert.isString(variantId);
  return variantId;
}

function getWorkspaceUrl(cheerio: CheerioAPI): string {
  const workspaceUrl = cheerio('a:contains("Open workspace")').attr('href');
  assert(workspaceUrl);
  assert.isString(workspaceUrl);
  return workspaceUrl;
}

/**
 * Makes an empty submission to the specified URL. Returns the submission ID.
 */
async function makeSubmission(url: string, cheerio: CheerioAPI): Promise<string> {
  const form = cheerio('form.question-form');
  const res = await fetchCheerio(url, {
    method: 'POST',
    body: new URLSearchParams({
      __csrf_token: form.find('input[name="__csrf_token"]').val() as string,
      __action: 'save',
      __variant_id: form.find('input[name="__variant_id"]').val() as string,
    }),
  });
  assert.equal(res.status, 200);

  const submission = res.$('[data-testid="submission-with-feedback"]');
  assert.lengthOf(submission, 1);
  const submissionId = submission.find('.js-submission-body').attr('data-submission-id');
  assert(submissionId);
  assert.isString(submissionId);
  return submissionId;
}

async function assertVariantAccess({
  questionBasePath,
  variantId,
  submissionId,
  workspaceUrl,
  expectedAccess,
}: {
  questionBasePath: string;
  variantId: string;
  submissionId: string;
  workspaceUrl: string;
  expectedAccess: boolean;
}) {
  // Remove trailing slash if present.
  questionBasePath = questionBasePath.replace(/\/$/, '');

  const isStudentRoute = !!questionBasePath.match(/course_instance\/\d+\/instance_question\//);

  // Test access to the rendered variant.
  const variantUrl = `${siteUrl}${questionBasePath}${isStudentRoute ? '' : '/preview'}?variant_id=${variantId}`;
  const variantRes = await fetchCheerio(variantUrl);
  assert.equal(variantRes.status, expectedAccess ? 200 : 403);

  // Test access to a generated file for the variant.
  const generatedFileUrl = `${siteUrl}${questionBasePath}/generatedFilesQuestion/variant/${variantId}/file.txt`;
  const generatedFileRes = await fetch(generatedFileUrl);
  assert.equal(generatedFileRes.status, expectedAccess ? 200 : 403);
  if (expectedAccess) {
    assert.equal(await generatedFileRes.text(), 'This data is generated by code.');
  }

  // Test access to a submission file.
  const submissionFileUrl = `${siteUrl}${questionBasePath}/submission/${submissionId}/file/submission.txt`;
  const submissionFileRes = await fetch(submissionFileUrl);
  assert.include(expectedAccess ? [200] : [403, 404], submissionFileRes.status);
  const submissionFileText = await submissionFileRes.text();
  if (expectedAccess) {
    assert.equal(submissionFileText, 'Submitted data.');
  } else if (submissionFileRes.status === 404) {
    // Ensure that we got a 404 from the submission file route, which will give
    // us an empty file. We want to error if for some reason it's a 404 because
    // the route couldn't be found.
    assert.equal(submissionFileText, '');
  }

  // Test access to a rendered submission.
  const submissionUrl = `${siteUrl}${questionBasePath}${isStudentRoute ? '' : '/preview'}/variant/${variantId}/submission/${submissionId}`;
  const submissionRes = await fetch(submissionUrl);
  assert.equal(submissionRes.status, expectedAccess ? 200 : 403);
  if (expectedAccess) {
    const data = await submissionRes.json();
    assert.property(data, 'submissionPanel');
  }

  // Test access to the variant's workspace.
  const workspaceRes = await fetchCheerio(siteUrl + workspaceUrl);
  assert.equal(workspaceRes.status, expectedAccess ? 200 : 403);
}

describe('Variant access', () => {
  before(helperServer.before());
  after(helperServer.after);

  let question: Question;
  let assessment: Assessment;
  let publicVariantId: string;
  let publicVariantWorkspaceUrl: string;
  let publicVariantSubmissionId: string;
  let otherPublicVariantId: string;
  let otherPublicVariantWorkspaceUrl: string;
  let otherPublicVariantSubmissionId: string;
  let studentInstanceQuestionPath: string;
  let studentVariantId: string;
  let studentVariantWorkspaceUrl: string;
  let studentVariantSubmissionId: string;
  let otherStudentInstanceQuestionPath: string;
  let otherStudentVariantId: string;
  let otherStudentVariantWorkspaceUrl: string;
  let otherStudentVariantSubmissionId: string;
  let instructorVariantId: string;
  let instructorVariantWorkspaceUrl: string;
  let instructorVariantSubmissionId: string;

  step('select relevant entities', async () => {
    question = await selectQuestionByQid({
      course_id: '1',
      qid: 'variantAccess',
    });

    assessment = await queryRow(
      'SELECT * FROM assessments WHERE tid = $tid',
      { tid: 'hw11-variantAccess' },
      AssessmentSchema,
    );
  });

  step('configure instructor permissions', async () => {
    const adminUser = await getConfiguredUser();
    const instructorUser = await getOrCreateUser(INSTRUCTOR_USER);
    await insertCoursePermissionsByUserUid({
      course_id: '1',
      uid: instructorUser.uid,
      course_role: 'Owner',
      authn_user_id: adminUser.user_id,
    });
    await insertCourseInstancePermissions({
      course_id: '1',
      course_instance_id: '1',
      user_id: instructorUser.user_id,
      course_instance_role: 'Student Data Viewer',
      authn_user_id: adminUser.user_id,
    });
  });

  step('configure course assistant permissions', async () => {
    const adminUser = await getConfiguredUser();
    const courseAssistantUser = await getOrCreateUser(COURSE_ASSISTANT_USER);
    await insertCoursePermissionsByUserUid({
      course_id: '1',
      uid: courseAssistantUser.uid,
      course_role: 'Editor',
      authn_user_id: adminUser.user_id,
    });
  });

  step('enable question sharing', async () => {
    await features.enable('question-sharing', { institution_id: '1', course_id: '1' });
    await updateCourseSharingName({
      course_id: '1',
      sharing_name: 'test-course',
    });
  });

  step('create variant from public question preview', async () => {
    await withUser(PUBLIC_USER, async () => {
      const url = `${siteUrl}/pl/public/course/1/question/${question.id}/preview`;
      const res = await fetchCheerio(url);
      assert.equal(res.status, 200);
      publicVariantId = getVariantId(res.$);
      publicVariantWorkspaceUrl = getWorkspaceUrl(res.$);
      publicVariantSubmissionId = await makeSubmission(url, res.$);
    });
  });

  step('create other variant from public question preview', async () => {
    await withUser(OTHER_PUBLIC_USER, async () => {
      const url = `${siteUrl}/pl/public/course/1/question/${question.id}/preview`;
      const res = await fetchCheerio(url);
      assert.equal(res.status, 200);
      otherPublicVariantId = getVariantId(res.$);
      otherPublicVariantWorkspaceUrl = getWorkspaceUrl(res.$);
      otherPublicVariantSubmissionId = await makeSubmission(url, res.$);
    });
  });

  step('create variant from instructor question preview', async () => {
    await withUser(INSTRUCTOR_USER, async () => {
      const url = `${siteUrl}/pl/course/1/question/${question.id}/preview`;
      const res = await fetchCheerio(url);
      assert.equal(res.status, 200);
      instructorVariantId = getVariantId(res.$);
      instructorVariantWorkspaceUrl = getWorkspaceUrl(res.$);
      instructorVariantSubmissionId = await makeSubmission(url, res.$);
    });
  });

  step('create variant from student assessment instance', async () => {
    await withUser(STUDENT_USER, async () => {
      const assessmentUrl = `${siteUrl}/pl/course_instance/1/assessment/${assessment.id}`;
      const assessmentRes = await fetchCheerio(assessmentUrl);
      assert.equal(assessmentRes.status, 200);

      const instanceQuestionPath = assessmentRes
        .$('a:contains("Test access to a variant and its resources")')
        .attr('href');
      assert(instanceQuestionPath);
      assert.isString(instanceQuestionPath);
      studentInstanceQuestionPath = instanceQuestionPath;

      const instanceQuestionUrl = siteUrl + studentInstanceQuestionPath;
      const addVectorsQuestionRes = await fetchCheerio(instanceQuestionUrl);
      assert.equal(addVectorsQuestionRes.status, 200);
      studentVariantId = getVariantId(addVectorsQuestionRes.$);
      studentVariantWorkspaceUrl = getWorkspaceUrl(addVectorsQuestionRes.$);
      studentVariantSubmissionId = await makeSubmission(
        instanceQuestionUrl,
        addVectorsQuestionRes.$,
      );
    });
  });

  step('create variant from other student assessment instance', async () => {
    await withUser(OTHER_STUDENT_USER, async () => {
      const assessmentUrl = `${siteUrl}/pl/course_instance/1/assessment/${assessment.id}`;
      const assessmentRes = await fetchCheerio(assessmentUrl);
      assert.equal(assessmentRes.status, 200);

      const instanceQuestionPath = assessmentRes
        .$('a:contains("Test access to a variant and its resources")')
        .attr('href');
      assert(instanceQuestionPath);
      assert.isString(instanceQuestionPath);
      otherStudentInstanceQuestionPath = instanceQuestionPath;

      const instanceQuestionUrl = siteUrl + otherStudentInstanceQuestionPath;
      const addVectorsQuestionRes = await fetchCheerio(instanceQuestionUrl);
      assert.equal(addVectorsQuestionRes.status, 200);
      otherStudentVariantId = getVariantId(addVectorsQuestionRes.$);
      otherStudentVariantWorkspaceUrl = getWorkspaceUrl(addVectorsQuestionRes.$);
      otherStudentVariantSubmissionId = await makeSubmission(
        instanceQuestionUrl,
        addVectorsQuestionRes.$,
      );
    });
  });

  step('public preview does not show variant for different user', async () => {
    await withUser(PUBLIC_USER, async () => {
      await assertVariantAccess({
        questionBasePath: `/pl/public/course/1/question/${question.id}`,
        variantId: otherPublicVariantId,
        workspaceUrl: otherPublicVariantWorkspaceUrl,
        submissionId: otherPublicVariantSubmissionId,
        expectedAccess: false,
      });
    });
  });

  step('public preview does not show variant created by instructor', async () => {
    await withUser(PUBLIC_USER, async () => {
      await assertVariantAccess({
        questionBasePath: `/pl/public/course/1/question/${question.id}`,
        variantId: instructorVariantId,
        workspaceUrl: instructorVariantWorkspaceUrl,
        submissionId: instructorVariantSubmissionId,
        expectedAccess: false,
      });
    });
  });

  step('public preview does not show variant created by student', async () => {
    await withUser(PUBLIC_USER, async () => {
      await assertVariantAccess({
        questionBasePath: `/pl/public/course/1/question/${question.id}`,
        variantId: studentVariantId,
        workspaceUrl: studentVariantWorkspaceUrl,
        submissionId: studentVariantSubmissionId,
        expectedAccess: false,
      });
    });
  });

  step('instructor preview shows variant created in public preview', async () => {
    await withUser(INSTRUCTOR_USER, async () => {
      await assertVariantAccess({
        questionBasePath: `/pl/course/1/question/${question.id}`,
        variantId: publicVariantId,
        workspaceUrl: publicVariantWorkspaceUrl,
        submissionId: publicVariantSubmissionId,
        // TODO: Once we make the necessary changes, this should 403. We'll have to
        // update the name of this test too.
        expectedAccess: true,
      });
    });
  });

  step('instructor preview shows variant created by student', async () => {
    await withUser(INSTRUCTOR_USER, async () => {
      await assertVariantAccess({
        questionBasePath: `/pl/course/1/question/${question.id}`,
        variantId: studentVariantId,
        workspaceUrl: studentVariantWorkspaceUrl,
        submissionId: studentVariantSubmissionId,
        expectedAccess: true,
      });
    });
  });

  step('course assistant preview does not show variant created by student', async () => {
    await withUser(COURSE_ASSISTANT_USER, async () => {
      await assertVariantAccess({
        questionBasePath: `/pl/course/1/question/${question.id}`,
        variantId: studentVariantId,
        workspaceUrl: studentVariantWorkspaceUrl,
        submissionId: studentVariantSubmissionId,
        expectedAccess: false,
      });
    });
  });

  step('student instance question does not show variant created by other student', async () => {
    await withUser(STUDENT_USER, async () => {
      await assertVariantAccess({
        questionBasePath: studentInstanceQuestionPath,
        variantId: otherStudentVariantId,
        workspaceUrl: otherStudentVariantWorkspaceUrl,
        submissionId: otherStudentVariantSubmissionId,
        expectedAccess: false,
      });
    });
  });

  step('student instance question does not show variant created by instructor', async () => {
    await withUser(STUDENT_USER, async () => {
      await assertVariantAccess({
        questionBasePath: studentInstanceQuestionPath,
        variantId: instructorVariantId,
        workspaceUrl: instructorVariantWorkspaceUrl,
        submissionId: instructorVariantSubmissionId,
        expectedAccess: false,
      });
    });
  });

  step('student instance question does not show variant created in public preview', async () => {
    await withUser(STUDENT_USER, async () => {
      await assertVariantAccess({
        questionBasePath: studentInstanceQuestionPath,
        variantId: publicVariantId,
        workspaceUrl: publicVariantWorkspaceUrl,
        submissionId: publicVariantSubmissionId,
        expectedAccess: false,
      });
    });
  });
});
