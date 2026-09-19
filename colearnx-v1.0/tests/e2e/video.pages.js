export class TrainerVideoPage {
  constructor(page) { this.page = page; }
  async open(courseId) { await this.page.goto(`/#/trainer/course-editor?draft=${courseId}`); }
  async upload(file) { await this.page.getByLabel("Choose course video", { exact: true }).setInputFiles(file); }
  submitButton() { return this.page.getByRole("button", { name: "Submit for administrator review" }); }
  async refreshVideo() { await this.page.getByRole("button", { name: "Refresh video status" }).click(); }
}
export class LearnerVideoPage {
  constructor(page) { this.page = page; }
  async open() { await this.page.goto("/#/purchases"); await this.page.getByRole("button", { name: "Open delivery", exact: true }).click(); }
  player() { return this.page.getByRole("region", { name: "Online course video" }); }
  async seekTo(seconds) { await this.page.getByLabel("Course video", { exact: true }).evaluate((video, value) => { video.currentTime = value; }, seconds); }
  async pause() { await this.page.getByLabel("Course video", { exact: true }).evaluate(video => video.pause()); }
  async openRefund(courseId) { await this.page.goto(`/#/refund/${courseId}`); }
}
export class AdminVideoPage {
  constructor(page) { this.page = page; }
  async open() { await this.page.goto("/#/admin/catalog"); }
  async preview() { await this.page.getByRole("button", { name: "Preview ready video" }).click(); }
  approveButton() { return this.page.getByRole("button", { name: "Approve", exact: true }); }
}
