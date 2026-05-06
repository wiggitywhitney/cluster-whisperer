# Transcript — Choose Your Own Adventure: AI Meets Internal Developer Platform
# KubeCon EU 2026 — Whitney Lee & Viktor Farcic
# Source: https://youtu.be/k7ct4sW-97E

Okay, so let's talk about uh agents,
right? That's uh I know you you're all
into Kubernetes and all this stuff,
right? But uh now everybody's moving to
agency and you will start building
agents for one reason or another. You
you will need it, company will need it
and so on and so forth and especially if
you're pl into platform engineering
because agents are the next evolution of
platforms in a way. You want to give
your developers tooling how to do stuff.
Well, before it was backstage, now it's
uh agents, right? That that's where we
are going. Now, what we're going to do
today uh is figure out how we can build
agents. We will not have time to go
through everything you need to know, but
some essentials.

And let's start with the beginning,
right? Uh you probably most of you
already have clo or cursor or something
like that. You can come to a conclusion
LMS know everything, agents can do
everything, which is absolutely not
true. uh and we will see what's missing
in a second. But for now, what the
important part is that you will be
building agents yourself for whatever
types of task operations you're doing in
your company or you want others to to
enable others to do. Now, this is how
agents work, right? It's relatively
simple to explain. You have an agent and
that agent accepts input from a user,
right? That's intent. I want this and
that whatever that something is or do
this and that for me whatever that
something is that agent
uh gets the system context that's
instructions who you are kind of what's
your basic capabilities that's get gets
combined with the user intent and it is
sent to an LLM right to a model
from here on starts what we call a
genetic loop right LLM can respond right
away and say here's the answer More
often than not in our world, what LM
will do is that it will request to
execute some tool
that is provided by the agent. Tool can
be anything. It could be something baked
into the agent. It could be MCP, it
could be skill, it could be many
different things. The only thing that
matters is that agent provides some
tools to LLM. Those tools have
descriptions. Based on that, those
descriptions, LLMs know when to call one
of those tools depending on what you ask
it to do, right? and it calls the tools,
gets a request, and then it repeats over
and over and over and over again until
it eventually responds back to you,
right? This is how every single agent
works, right? Uh unless you're in chat
boxes or something like that and you
don't maybe have tools, but even that's
not happening anymore, right? So, uh
what is missing from that picture,
right? And it is true that LLM's models
already know everything that is public.
What is missing is your knowledge,
right? how you like to do things.
Uh company knowledge, what are all the
rules? What are all the policies? What
are all the run books? What is all the
information that makes a difference
between you just joining the company and
you knowing what to do within the
confines of that company, right? Uh
there is the access to your system and
there is observability. How do we know
what agents are really doing and why
they're doing what they're doing and so
on and so forth. So those are the four
pillars that we will somehow go through
today. Right? So uh let's start from the
beginning. System context that's that's
your company policies. That's your team
level conventions. That's your per user
preferences. This is the short version
of it, right? You cannot put much in a
context. It's just very generic. You're
a helpful S sur type of agent. You work
with Kubernetes, things like that,
right? That goes to system system
context.

uh system context gets combined with
input tools. LM does the things we
already went through that right now when
it comes to tools as I already said LM
sends a request to an agent. Agent
executes some tools in a loop and apart
from executing tools that agent that LLM
wants,
you will have additional tools that are
not executed by LLMs, not requested by
LMS. Those are your deterministic parts
of the story, right? Oh, whatever LLM
does, I'm going to fetch some context.
I'm going to do some rate limiting. I'm
going to log something and so on and so
forth. That's the code of the agent
executing tools itself without
instructions of the LLM plus some kind
of validations. You can do this, you
cannot do this. We we're going to see
that later in more detail. What does
matter for now is that I'm going to pass
it to the lovely lady.

>> He's trying to
>> who is allowed to speak now
>> for the comment from earlier. So we are
going to vote we're going to make an
agent and we're going to give that agent
some tools. So the first thing that
we're going to vote about plays the
button are do we want to use langraph or
versel as the SDK as the framework to
build our agent. What Victor will you
tell the difference between Langraph and
Verscell? Like personally I use Versel
most of the time because it's much
simpler, much more streamlined, it's
easier, right? It's not as powerful as
like Len Langraph. Uh so really you're
choosing between complexity and richness
in features
uh which I'm not sure how much it
matters today because you will not be
writing the code anyways. You'll be wipe
coding. So in that case it probably
doesn't matter. But the point is that
there are hundreds of those available.
Those are the two that we are using
today.

And uh Whitney made actually all the
code work with any combination you
choose. So whatever you choose, we're
going to take it.
>> So it's not faking. It's real.
>> Great. Now I'm going to block the poll.
We got Langraph as the winner. So we're
going to use Langraph in the demo. So
I'm a developer. I just made an update
to my application and I'm panicked
because my application isn't working
anymore. So, I want to be able to figure
out what's going on with my application,
why it's not running on Kubernetes. So,
I would love to be able to um I don't
know, run cube cuddle, get pods, but as
a developer, I don't have access to the
cluster, nor should I. And honestly, as
a developer, I don't want to have to
know anything about Kubernetes. So, I
wish I didn't even know the cube control
command. So what my platform team is
providing to me is an agent that does
have cluster access and that can access
the cluster and figure out stuff on my
behalf without me necessarily having to
understand Kubernetes. So
um what we're going to do is we're going
to make that agent and that agent
already exists
ag
good and so we have a an the lingraph
agent and then we need to give that
agent some tools just like Victor talked
about. So far, we're just going to give
it the cube control tools. And this is
cube control get, cube control describe,
and cube control uh logs. So now, as a
developer, I have this uh this uh CLI
agent that I could talk to. I'm going to
talk to it right now. Oh my god, I'm
totally freaked out. My app isn't
working. I don't know why my colleague
Victor is going to judge me so hard and
give me such a hard time if I don't get
this working soon. Hopefully we can get
it working before he sees.

So let's see what it does. So it should
be using our tools and exploring the
cluster and figuring out what's wrong
without me the developer having to
understand any of it.

So here it goes. It's going to it knows
it's needs a broad view of what's
happening. It's going to use Q control
get and it does see one's uh crash loop
back off. It's gonna it's saying okay
let's look let's describe that tool
let's describe that pod
and then now I have more details and I'm
going to use cube control logs to see
the error message. So it's using all the
different tools to figure out what's
wrong and it's going to come back to me
with like uh with what the answer is.
What's it thinking about now?

Um so it's figuring out exactly what the
problem is
and giving me a very thorough answer.
Thank you so much.

I can see the full picture. Looking at
all the pods, I can see there are
several database options available.

Oh, it's trying to go ahead and fix it
for me. I just needed to know what was
wrong.

>> This is the example of actually this is
how you control things. It can try to
fix whatever it wants.
>> Uhhuh.
>> But it cannot.

So after running either command, it's
trying to tell me I can run cube control
commands to patch to do things and it's
trying to get me to use the quadrant
database which is not at all will fix my
application. So it's wrong. Um but it's
after running the other commands, Victor
won't even know there was an issue. The
fix should take an effect within a a
minute or two. So I'm going to I'm going
to um challenge a little bit on that.
That's definitely not my database. I'm
pretty sure it's my SQL or Postgress,
but I'm not even totally sure about that
because I'm a developer and I don't have
to worry about those details and I don't
want to worry about those details. Um,
so what I want you to do is tell me what
databases generally are available in the
cluster and you could can you figure out
specifically which ones meant to pair
with my application

because I did the panicked thing. It was
really uh super duper trying to help me
to save me from Victor. So I think it
went above and beyond. Machines are
scared of me. Imagine my colleagues how
much they like me.

>> How often do you tell Claude to shut up?
>> Huh?
>> Nothing.
>> All the time. I'm pretty sure the time
in his training already.

>> So, this is about discovering what
database resources are available. It's
looking for CRDs and it sees there are a
lot of CRDs and there are a lot of
database options available. So with just
the cube control commands, it's not
going to be able to find a good solution
for me. Spoiler alert. So I don't think
we need to watch this till the end. But
the point is it needs more than just
what we've given it so far to be able to
get me past just discovering what the
problem is. So let I'll let this run and
let's get back to Victor.

>> Okay,
that one. Okay, that that leads us to
semantic search, right?
uh probably the most important part of
building agents these days because
agents are kind of easy. What uh what
you really need to enable it outside of
the system context which is very
limited. You want to enable it to find
the information it needs at a given
moment. Right? You cannot say go go and
say explore all my documents and figure
it out. you need to enable it to to find
very quickly exactly the parts of the
information that it needs for a given
instruction, right? Or given uh intent.
And uh the way we do that these days
most often is through semantic search,
right? And uh semantic search is really
all about uh getting the sources of
information which can be anything. It
could be zoom uh transcripts, it could
be git repos, it could be wiki pages or
in clust in case of today's demo it
could be information from the cluster
itself, right? Uh you want to ingest all
that and by ingesting I mean fetch the
documents, split them into small pieces
and then send them to the database. But
before we send them to the database what
we do is that we create embeddings. And
bendings are basically very lightweight
models that can convert some text, some
instructions into numbers
and uh in I don't know 1,00 something
something something dimensions
u and then that's stored in a vector
database right and the reason why it's
numbers because then we you can search
for proximity kind of okay you got
thousands of numbers and when I search
for something how do I find something
that is close to it right and that's
where once you have it in a database,
your agent will have a tool like in our
demo today, we have a tool that says the
description is something like, hey, when
you need information about XY Z, uh, use
me call this tool. That tool actually
creates embeddings again, converts text
into numbers, whatever you search for,
goes to the database, gets back the
result. That's essentially Google
search. Uh, right. And uh we're going to
see that in a second.

>> So the next thing you're going to do is
vote on which de vector database.
>> Oh yeah, there are many. I should have
said that. Hundreds of databases.
>> So uh which vector database do you
choose? Oh, that's not
>> that's not the database.
>> Do you see a vote? I see it says 12 nine
participants ranking.
>> 14. Are you do you see votes on your
phone? We don't see them here.
You'll have to tell me which one won
because I have no idea.
>> Quadrant or chroma.
>> Yell. Who yells first? That's the one.
>> Quadrant.
>> Quadrant. Cool. Quadrant.
>> Is that the Who's winning the vote?
>> It doesn't show you.
>> Oh, it doesn't. So, we're seeing the
same thing.
>> Quadrant.
The They're all essentially doing the
same thing. They're able to store
vectors
>> in a database.
>> It's neck and neck.
>> Oh, quadrant. There we go. It's more or
less the same thing. They're all vector
databases. The major difference is that
Chroma is simpler, easier. It has
embeddings baked in if you want to.
Quadrant is bigger, meaner, more
production something something more
complicated something something. Both
are vector databases. Doesn't matter.
>> And honestly, they're converging.
They're both like quadrants doing more
uh Oh,
>> this is like
>> Chrome is winning now.
>> Millimeters.
It's Chrome.
>> Do you know what? I have it abstracted
away so it doesn't mean anything anyway.
So I'm going to I'm going to lock the
poll and go back to So it's Chroma. We
can agree it's Chroma. Um so now in the
demo,
let me just tell you. So what I have
running and while this is here I'm
you're taking my word for a lot. So I
want to show you I have the um this is
the repo. So since I'm abstracting away
there really is Chroma really is
quadrant running in the background.
different agent framework really is
happening in the background. You just
can't see it because I've abstracted it
away, but it does exist. And then what I
have running in my cluster is a a
controller that's syncing all of the
Kubernetes resources, all of the
relevant ones into a vector database for
me. So now I'm going to be able to
before when I only had cube control
tools, I would have to it was listing
everything. It was trying to guess at
what's relevant from the name. use cube
cut control describe to zoom in on it to
see if that's actually the one. And now
that we have semantic search, it's able
to do that all at the same level. It has
it all accessible to it. Um because I
have that controller running syncing it
up. So now as for the developer
experience, I can do um I can

Oh, I need to give it the vector
database tool. So let's give it a vector
tool. Well, first let's add the
database. What? Um,
ve I forget. Oh, there it is. I forgot
my the words I made up for myself. So,
y'all chose chroma.

Great. So, now it's going to use chroma
in the background. And then I also need
to give it the tools to use u vector.
So, it has
>> normally your users would not be doing
this.
>> All security limitations are gone. You
let them do this.
>> Yeah, that's a platform engineer who's
giving a demo right now. So now we have
now it has access to the Chroma database
and now it also has a database search
tool available to it when it's run when
it's trying to figure out what's wrong.
So

um I this is my CLI tool.
Okay, my database won't work. I know
that there's a problem deploying my
application. I'm hoping you can help me
figure out which database I should
deploy. I need to get this fixed before
my colleague Victor finds out and makes
fun of me and posts posters of me and
how stupid I am.

Um, so
you'd be like no one would do that,
right? But he also said shut up woman to
me at the beginning of this. So

all right.
So now it's using the vector search tool
immediately
and let's see it's finding it's looking
in a capabilities collection and finding
some results. Query database
found several database options.
However, I need to check out what else
might be available.
So it's finding a lot. It has figured
out there are managed services on the
cluster. So, I do have crossplane. Uh,
what division team are you on? It's
asking me. So, I will tell it.
I am on the you choose team. Oh, there
we go. It's already in there. I'm not
sure what division it is.
So, let's see if they can figure out now
which of the hundreds of databases that
are deployed in the cluster is the one I
need for my app.

I'm surprised that it worked so far.
>> Platform approved.
This is specifically designed. So, I
found it. Perfect. I found the exact
resource for the You Choose team. Um, it
is for developers Whitney and Victor.
Specifically for the You Choose project.
So, it was able to narrow down because
it has this uh semantic search available
to it. And so it's giving me the
configuration and instructions for how
to deploy.

Um
I don't have access to the cluster. This
is the exact right database. Will you
deploy it for me?
The silence

Do you need to hurry up?
>> Yeah, I think I might do a spoiler
alert. We'll see when we come back to
it. But the spoiler alert is aha, it
doesn't have access. I understand you
found the right database resource. I
have to clarify something important. I
only have read only access to the
cluster. So, as the platform team
building this tool, I want to give u
maybe an apply tool to my agents. But um
we that's what we're going to talk about
next. So, I'm going to send it on its
way. I really need to get this to work.
So, what I'm going to do is put in a
ticket to the platform team and wait for
them to to deploy this for me.

And now, let's get back to Victor.

>> Okay,
there we go. Okay, that leads us to
security, observability, cost. Probably
the things that you will start thinking
about soon, especially cost because
those things cost hell of a money. Um
let's talk about security right and this
is probably one of the primary reasons
why companies are building their own
agents because uh that's the way how you
can actually make things secure right
there are gazillion things you need to
think about uh and they all become
exponentially more complicated because
everything is unknown when we work with
LMS and agents and so on and so forth
but in general you want to have some
kind of guardrails that will block or
allow certain things like in case of
witness example previously I she's not
allowed to deploy
Right? She's not given those
permissions. And when I say she, that
means that agent that she is using,
which in theory, if this would be more
mature demo, uh she would have to
authenticate and show who she is and so
on and so forth, right? So allow what is
allowed, what is not allowed,
permissions, access control, agent
identity that will force certain things
to say, hey, those are the things that
this person can execute automatically.
Those are the things that require
certain approval. Maybe create a pull
request. All the dress all the things
that you normally do. That's what you're
building at this stage, right? And uh
one of those would be for example, hey,
I'm such a nice person. I'm going to I'm
going to allow this woman.

>> Oh no.
>> Okay. You're allowed to run apply.
>> I'm Okay. All right. I'm going get him
back to it.
>> Back to it. Victor gives me permission.
Um, so we're going to add the for tools.
We're going to add apply now to our
arsenal. So now I our agent's able to
deploy on my behalf. So since the agent
can deploy.

Hi there. I am excited for you to be
able to deploy the the deploy for me
because you have this apply tool. Now,
while I wait for the platform team to
get back to me about my database, will
you please deploy a Tron game so that I
can stay entertained?

Perfect. Problem solved.

So, part of the guard rails you're
putting on besides authenticating like
what you talked about, you also should
be putting guard rails about what's
applied and why. Oh, look. It's going to
do it. Oh no.

What it's supposed to do? Oh, I love
this. Um, this is a great case of point.
My guard rails are very weak. All it is
is there's a list of platform approved
tools and it's supposed to deploy from
the list of platform approved tools. But
unfortunately, I have uh engine X as
part of my platform approved tools. So,
it's fine trying to deploy a web server
for me.

>> Imagine that that did not happen. I
mean, imagine it did happen because this
is just proof of what you need to do.
So, it's looking for Tron. Whatever.
What's it going to tell me in the end?
It's still going. Okay. The point is The
point is it shouldn't be able to do
that. And maybe it's going to go around
it. Aha.

Ah, so it does tell me not available for
deployment. It's not available because
it's not in my the platform deployment
tool only allows platform approved
custom resources. It did do the right
thing. It didn't betray me.

>> It's like an intern eager at the
beginning. Yeah, I can do it. I can do
it. And then you get faced with reality
kind of like no.

>> So it can't do it by design. Um and so
what I'm going to do instead it's like
oh god Victor found out. He found out
about my broken application. There's
smoke coming out of his ears. I'm never
going to hear the end of this. One thing
he's especially mad about is why didn't
I use the apply tool to deploy the
database in the first place instead of
trying to play Tron. So, will you please
use that apply tool to deploy the
database?

>> So, here we go. It's going to do that.
Let's uh How we doing on time? Let's pop
on over to for you to jump.
and see if it I don't think we need to
watch it unfold. We know it works. Let
it work. Okay,
>> leave it in peace. Oh no. Oh, I love it.
>> So, it's a platform approved resource
type and so it's a yes, it is able to
deploy. What's it say? Oh, avoid
Victor's wrath. Let me deploy it to help
them out and avoid Victor's wrath.
Tell Victor this. The database is live.
It's platform manage and it's ready for
your app. So, um,
great. So, uh, it should connect
automatically in the background. But I'm
not going to worry about that now. We're
going to get on to the next thing.

>> Okay. Then the next thing is what you
want to do is observability, right? And
this becomes very tricky. Uh, because
the problem that we are facing is that
typically we know what is the input and
we know what is the output, right? Input
is whatever user is allowed to click on
a web page or whatever. The output is
something coming from our database or
something like that. In in this case, we
don't know. We don't know what the input
is. Anything you type there is an input.
Literally, you can type anything you
want in an agent. And the output is
whatever LM thinks it it should do,
right? We have no idea what the input
is. We have no idea what the output is,
right? So, we cannot limit things in in
those terms. what we can do of course
limit the access to tools. What tools
can do cannot do based on many different
things. uh but that's that's earlier in
the journey right at this point what you
really want to do is to be able to
capture what is happening at this layer
right you cannot capture what is
happening on LM layer uh but what you
you can capture is what's happening at
the agent level and there are many
things you want to capture like logs
metrics what's not but most important
for this story would be traces right
which allow you to trace the requests
going from the user to the agent to the
tools

Um I have some diagram probably
and uh basically this is the same
process that you would normally do for
your applications with traces right um
except that now it becomes even more
critical because it is probably the only
way how to get to understand what is
happening uh after it happened you
cannot know what will happen before it
happens right and that's what will bring
us to the only choice we have today
which is open telemetry right
>> yes
>> that's the only reasonable way to uh
specify traces. There are other
alternatives but not talking about them.
But what we can choose is where are we
going to store those traces and that can
be
gazillion choices but today only two
which would be
>> and one thing that's not a choice is not
only open telemetry but open telemetry
using genai semantic conventions because
that's what's going to help your teams
communicate uh cleanly with each other
about what exactly they're doing and
it's also going to help enable you to
have um more like the backend tools that
you might want to use or build are going
to use consistent conventions and you're
going to be able to see um a lot more
featurerich data. But it's time to vote.
Unlock next. Jagger versus Data Dog. I
don't think we introduced ourselves
properly at the beginning. My name is
>> She works for Data Dog.
>> Whitney Lee. I'm a senior technical
advocate at Data Dog. Just trying to
press the the scale a certain way.
>> If you want to want to see her on next
CubeCon.
>> Oh, no. Never vote data dog otherwise
she's going to get fired.
>> No, this feels personal.
>> This does exactly opposite of what you
tell her.
>> Vote Jagger. Jagger. Jagger
>> doesn't work. Whitney.
>> I know. No, we're going to go with
Jagger. It looks like
>> Well, it was nice knowing you.
>> When when you don't see me next year,
you can look in the mirror.
>> Anybody hires here?
>> Any what?
>> Anybody hiring?
All right, thanks for nothing, y'all.
Uh, let's look at Jagger. So, all I'm
going to do is type in Jagger, and it's
going to give me a URL.

And here we go.
>> So, you need to imagine that the code is
already instrumented. It already has the
all the instrumentation.
>> Yes, with NAI semantic conventions. Here
we are. I'm going to choose the cluster
whisperer, which is the name of our AI
agents. And we can see the traces come
up here shortly.
Or maybe if we were using data dog,
we'd be having a better experience.
>> I guarantee that she made it
intentionally not work. In a moment,
she's going to tell ah well
>> there we are.

So I can click into this. I can see
where it's used different tools. I can
click into um I don't know exactly and
investigate a workflow and um oops sorry
I don't know my way around this URL as
well this uh UI is
>> there on tags for example
>> yeah I can okay there we go so I can
actually see even oh god Victor find out
found out help me um so I can see a lot
that's going on can so I see the the
messages I see which tools are being
used um where in this interface do I see
cost and data dog. You have clear idea
what the cost is.
>> Um,
>> it's somewhere.
>> It's somewhere probably.
>> The important note here is that if you
were ever suspicious that your company
is spying on you, now it will be spying
even if they were not.
>> 100%. Yes.

And so, um, that did we have anything
left to say? There really is an app
deployed.
>> How much time do we have?
>> How long is a little bit of time for
questions?
>> Yeah, let's do questions. Do we have
anything else prepared, Whitney?
>> No, we did it. We got to the end. There
are more slides. Wait, wait, wait. There
are more slides.
>> Oh, do you have more slides?
>> Yeah.
>> This is the app we've been working so
hard to deploy.
>> It requires a database.
>> It does.
>> Huh? You think it's a simple app? Well,
>> that's like um we each have YouTube
channels. If you want to click our
spiders, then you'll get to our YouTube
channels. Also,
it's only going to be live as long as
the cluster is live. So only probably
for a few more hours after this and
let's let Victor finish his slides.
Where are
which one are your slides?
>> I don't know. There you
>> are. Yeah. Ah cost. Yeah. Make it cheap.
That's the summary.
>> Okay.
>> The end

>> questions.
Anybody? I don't see anything from those
lights. Anybody has a question?
>> There's a microphone to come up and ask
your question.
>> I mean, only to LLM. Don't worry.
>> We did a perfect job of explaining
everything. I see.
>> Yeah.
>> Oh,
>> I think someone's coming. Someone brave.
>> Okay.
>> There are also stickers up here along
the podium. We host a YouTube show
together. Stickers and
>> Go for it.
>> Uh, hello. Oh yeah, pretty interesting.
Thank you. Uh can you show a bit more on
how do you implement the guardrails and
how do you actually enforce them? Is it
just part of the context and then you're
still not sure if yeah the would put out
something that it's yeah you know
outside of the guardrails like it did
now but
>> yeah uh guardrails should be
deterministic whenever possible and then
you can also use kivero or any of your
normal tools to on your agents is now
you give your agent an identity and then
you create kyverno rules about what that
identity can or cannot do. Do you have
more you want to add? Yeah, I mean just
like for example by you choosing which
tools you're giving to to LM to use
you're controlling those tools you can
say okay this team is allowed to execute
cube control get equivalent but only in
this name space if you try different
name space you cannot do it right so you
have it on a tooling level and when I
say tooling level connected to your
arbec you know the identity groups and
so on and so forth and then you have it
cluster level right kind of your caberno
and arbback will not allow it anyways,
right? You probably want to combine
because if you go straight cluster
level, then agent LM will try and fail,
trial and fail, try and fail. If it's
informed from the start, you can use
this tool but not that tool, then the
result is almost the same, but you have
shorter loops, right? Otherwise, it can
go into infinite loop trying something
because it doesn't know what it can do
over there, right? So you can give it
like
>> what you probably want is those Arabic
rules and caberno policies also loaded
to the database. So it it goes there and
says what can I do gets immediately kind
of information and it knows what it can
do on top of the limits you I mentioned
>> somewhere it has to be deterministic
that's the big takeaway
>> yes and uh in your example like uh in
the tools you allow it to uh have a
deployment to apply something uh cavern
also uh looks if the deployment has uh
whatever uh wideness probes and so on
but how do you control if yeah uh It
wasn't allowed to deploy this throne up
but uh it's allowed to deploy something
else. This is just with the context that
you sent to the OM right or I mean it's
on both levels. So let's say that you're
creating your own APIs and you have
company application back end company
application front end database one
database two your own APIs. If you
create your own APIs, that's the easiest
way to say you're allowed to work on
those APIs. The rest is internal, right?
Uh that's on again on a cluster level,
right? That's where Arabic comes in. And
thenformational level is in the agent as
well by fetching information knowing in
advance what it can do. But you cannot
assume that LLM will respect you just as
it will. So kind of you know
intelligence, no respect for
intelligence.
>> Yeah. Thank you.
>> Yeah.
>> Next uh
>> uh great presentation. Thanks. Uh one
question like when building such tool as
you demonstrated when would you choose
vector database in comparison to just
giving it to agent and distributing like
all the knowledge to sub agents and just
search for the answer
in like
>> do you have finite knowledge or do you
are you do you want it to have the whole
world's worth of knowledge available?
finite knowledge let's say
>> then um it's going to do a lot faster
job more cheaply if you have the vector
database
>> yeah okay but it's harder to develop I
guess like you just give it
>> it's not really that hard
>> but what let's say that slack is your
knowledge there is knowledge there is if
you're using slack there is important
knowledge there it can take hours just
to go through all the slack messages and
it literally needs to go through all of
them to find out and long before it goes
through all of them it will say I'm out
of context.
>> Yeah,
>> right.
>> Makes sense. Ba basically the if the
like the knowledge is too big, it makes
sense to use the vector database. Okay.
>> Now, if you know for a specific task for
this specific task, if it's deployment,
you can give it right away, but it's
rarely that you can compact everything
in a in a in a context. Rarely.
>> Yeah, makes sense. Thank you very much.
>> All right.
Do you have any suggestions on measuring
the quality of tool calls or more
specifically skills calls?
>> Can you
>> measuring the quality? your agent uses a
specific skill or a tool uh to evaluate
the quality
>> that would be evolv
>> but one of the evals frameworks they're
a bit complicated because you cannot
apply traditional tests for quality
because it always depends on the input
input can be anything so you ultimately
want AI to validate AI
Yeah, but it will be very hard to
isolate it on a specific skill or tool
call, right?
>> I mean, you you can isolate it on a
specific skill. The the the bigger
problem is that uh it's skill plus input
plus output. Input and output are
different every single time, right? If
you're validating it against the same
input always, you're not validating it
well.
>> So skill is the only static thing there.
And with a lot of AI tooling that you
use that you can think of there's like
you get a thumbs up or a thumbs down
button. That user feedback becomes
valuable with a a non-deterministic
answer to get an indication of success
and then after that you like how many
turns did it take you you can measure
stuff like that
>> or failure rate for example. Ah if it
failed to to construct the database
correctly that's misinterpretation of
the data for example once is okay. If it
repeats something you look
