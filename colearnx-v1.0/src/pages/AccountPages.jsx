import { useState } from "react";
import {
  ArrowRight,
  BookOpen,
  BriefcaseBusiness,
  Edit3,
  Eye,
  GraduationCap,
  Library,
  Save,
  Sparkles,
  Star,
  UserCheck,
  WalletCards,
} from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { author, contents, courses } from "../data";
import { usePlatform } from "../context/PlatformContext";
import { Badge, Button, Card, FormField, Metric } from "../components/ui";

export function HomePage() {
  const { balance, applications, role, profile } = usePlatform();
  const navigate = useNavigate();
  const shortcuts = [
    [
      "Browse courses",
      "Compare Cloud, Local, Live and Record delivery.",
      GraduationCap,
      "/courses",
    ],
    [
      "Creator contents",
      "Unlock notes, videos, files and assets.",
      Library,
      "/contents",
    ],
    [
      "My learning",
      "Continue courses and open purchased contents.",
      BookOpen,
      "/purchases",
    ],
    [
      "Role pathways",
      "Apply to become a Trainer or Creator.",
      UserCheck,
      "/role-application",
    ],
  ];
  return (
    <>
      <section className="hero-banner">
        <div>
          <span className="eyebrow light">Member workspace · {role}</span>
          <h2>Welcome back, {profile.name}.</h2>
          <p>
            Continue learning, discover new resources or take the next step as a
            platform contributor.
          </p>
          <div className="button-row">
            <Button onClick={() => navigate("/purchases")}>
              Continue learning <ArrowRight size={17} />
            </Button>
            <Button variant="glass" onClick={() => navigate("/courses")}>
              Explore marketplace
            </Button>
          </div>
        </div>
        <div className="hero-orbit">
          <Sparkles size={34} />
          <strong>{balance}</strong>
          <span>available points</span>
        </div>
      </section>
      <div className="metric-grid three">
        <Metric
          label="Points balance"
          value={balance}
          detail="Shared across purchases and income"
          icon={WalletCards}
        />
        <Metric
          label="Active learning"
          value="3"
          detail="1 Cloud course · 2 upcoming Live courses"
          icon={BookOpen}
        />
        <Metric
          label="Role applications"
          value={
            Object.values(applications).filter((v) => v === "Pending").length
          }
          detail="Pending platform reviews"
          icon={UserCheck}
        />
      </div>
      <div className="section-heading">
        <div>
          <span className="eyebrow">Quick access</span>
          <h2>What would you like to do?</h2>
        </div>
      </div>
      <div className="action-grid">
        {shortcuts.map(([title, description, Icon, to]) => (
          <button className="action-card" key={to} onClick={() => navigate(to)}>
            <span>
              <Icon size={21} />
            </span>
            <div>
              <h3>{title}</h3>
              <p>{description}</p>
            </div>
            <ArrowRight size={18} />
          </button>
        ))}
      </div>
    </>
  );
}

export function ProfilePage() {
  const { role, profile, saveProfile } = usePlatform();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(profile);
  return (
    <div className="profile-layout">
      <Card className="profile-hero-card">
        <div className="avatar large">
          {profile.name
            .split(" ")
            .map((part) => part[0])
            .join("")
            .slice(0, 2)
            .toUpperCase()}
        </div>
        <div>
          <div className="badge-row">
            <Badge tone="brand">Member</Badge>
            <Badge tone="success">Active account</Badge>
          </div>
          <h2>{profile.name}</h2>
          <p>{profile.bio}</p>
          <div className="profile-meta">
            <span>{profile.location}</span>
            <span>Joined June 2026</span>
            <span>{role} view</span>
          </div>
        </div>
        <Button
          variant="secondary"
          onClick={() => {
            setDraft(profile);
            setEditing(!editing);
          }}
        >
          {editing ? (
            <>
              <Eye size={17} /> Cancel editing
            </>
          ) : (
            <>
              <Edit3 size={17} /> Edit profile
            </>
          )}
        </Button>
      </Card>
      <div className="content-grid profile-columns">
        <Card>
          <div className="card-heading">
            <div>
              <span className="eyebrow">Personal information</span>
              <h3>Account details</h3>
            </div>
          </div>
          <div className="form-grid two">
            <FormField label="Full name">
              <input
                disabled={!editing}
                value={draft.name}
                onChange={(event) =>
                  setDraft({ ...draft, name: event.target.value })
                }
              />
            </FormField>
            <FormField label="Email">
              <input
                disabled={!editing}
                type="email"
                value={draft.email}
                onChange={(event) =>
                  setDraft({ ...draft, email: event.target.value })
                }
              />
            </FormField>
            <FormField label="Phone number">
              <input
                disabled={!editing}
                value={draft.phone}
                onChange={(event) =>
                  setDraft({ ...draft, phone: event.target.value })
                }
              />
            </FormField>
            <FormField label="Location">
              <input
                disabled={!editing}
                value={draft.location}
                onChange={(event) =>
                  setDraft({ ...draft, location: event.target.value })
                }
              />
            </FormField>
          </div>
          <FormField label="Bio">
            <textarea
              disabled={!editing}
              value={draft.bio}
              onChange={(event) =>
                setDraft({ ...draft, bio: event.target.value })
              }
            />
          </FormField>
          {editing && (
            <Button
              disabled={!draft.name.trim() || !draft.email.trim()}
              onClick={() => {
                saveProfile(draft);
                setEditing(false);
              }}
            >
              <Save size={17} /> Save changes
            </Button>
          )}
        </Card>
        <div className="stack">
          <Card>
            <span className="eyebrow">Current roles</span>
            <div className="role-list">
              <div>
                <span>
                  <UserCheck size={18} />
                </span>
                <div>
                  <b>Member</b>
                  <small>Active</small>
                </div>
                <Badge tone="success">Approved</Badge>
              </div>
              <div>
                <span>
                  <GraduationCap size={18} />
                </span>
                <div>
                  <b>Trainer</b>
                  <small>Not active</small>
                </div>
                <Badge>Not applied</Badge>
              </div>
              <div>
                <span>
                  <BriefcaseBusiness size={18} />
                </span>
                <div>
                  <b>Creator</b>
                  <small>Not active</small>
                </div>
                <Badge>Not applied</Badge>
              </div>
            </div>
          </Card>
          <Link
            className="button secondary wide"
            to="/public-profile/trainer-a"
          >
            <Eye size={17} /> Preview public profile
          </Link>
        </div>
      </div>
    </div>
  );
}

export function PublicProfilePage() {
  const [subscribed, setSubscribed] = useState(false);
  return (
    <>
      <Card className="public-profile-hero">
        <div className="avatar extra">AM</div>
        <div>
          <div className="badge-row">
            <Badge tone="brand">Verified Trainer</Badge>
            <Badge tone="violet">Creator</Badge>
          </div>
          <h2>{author.name}</h2>
          <p>{author.bio}</p>
          <div className="profile-meta">
            <span>
              <Star size={15} /> {author.rating} rating
            </span>
            <span>{author.followers} followers</span>
            <span>{author.specialty}</span>
          </div>
        </div>
        <Button
          variant={subscribed ? "secondary" : "primary"}
          onClick={() => setSubscribed(!subscribed)}
        >
          {subscribed ? "Subscribed" : "Subscribe"}
        </Button>
      </Card>
      <div className="metric-grid three">
        <Metric label="Public rating" value={author.rating} icon={Star} />
        <Metric label="Published courses" value="6" icon={GraduationCap} />
        <Metric label="Creative contents" value="12" icon={Library} />
      </div>
      <div className="content-grid two">
        <Card>
          <div className="card-heading">
            <div>
              <span className="eyebrow">Courses</span>
              <h3>Related learning</h3>
            </div>
            <Link to="/courses">View all</Link>
          </div>
          <div className="compact-list">
            {courses.slice(0, 3).map((item) => (
              <Link to={`/courses/${item.id}`} key={item.id}>
                <span className="list-icon">
                  <GraduationCap size={18} />
                </span>
                <div>
                  <b>{item.title}</b>
                  <small>
                    {item.category} · {item.price} points
                  </small>
                </div>
                <ArrowRight size={17} />
              </Link>
            ))}
          </div>
        </Card>
        <Card>
          <div className="card-heading">
            <div>
              <span className="eyebrow">Creator resources</span>
              <h3>Related contents</h3>
            </div>
            <Link to="/contents">View all</Link>
          </div>
          <div className="compact-list">
            {contents.slice(0, 3).map((item) => (
              <Link to={`/contents/${item.id}`} key={item.id}>
                <span className="list-icon">
                  <Library size={18} />
                </span>
                <div>
                  <b>{item.title}</b>
                  <small>
                    {item.type} · {item.price} points
                  </small>
                </div>
                <ArrowRight size={17} />
              </Link>
            ))}
          </div>
        </Card>
      </div>
      <Card>
        <span className="eyebrow">Reviews</span>
        <h3>Learner feedback</h3>
        <div className="review-grid">
          <blockquote>
            “Clear explanations and practical examples. I knew exactly what I
            was buying.”<footer>Jamie · AI Basics</footer>
          </blockquote>
          <blockquote>
            “The downloadable notes were concise and useful for revision.”
            <footer>Mina · AI Study Notes</footer>
          </blockquote>
        </div>
      </Card>
    </>
  );
}
